import os
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyapi'))

from feature_api import (
    FeatureError,
    chapter_output_paths,
    list_album_images,
    listing_page_window,
    map_category,
    map_order,
    map_ranking_period,
    map_time,
    parse_comments_payload,
    parse_feature_id,
    zip_output_path,
)


class FeatureApiHelpersTest(unittest.TestCase):
    def test_parse_feature_id_accepts_jm_prefix_and_whitespace(self):
        self.assertEqual(parse_feature_id(' JM 123 '), 123)
        self.assertEqual(parse_feature_id('jm12 345'), 12345)
        for value in ('', 'JM', '0', '-1', '1.5', 'abc', '9007199254740992'):
            self.assertIsNone(parse_feature_id(value), value)

    def test_category_order_time_and_ranking_aliases_map_to_library_tokens(self):
        self.assertEqual(map_category('同人'), 'doujin')
        self.assertEqual(map_category('全部'), '0')
        self.assertEqual(map_order('点赞'), 'tf')
        self.assertEqual(map_order('评分'), 'tr')
        self.assertEqual(map_time('本月'), 'm')
        self.assertEqual(map_ranking_period('周'), 'week')
        with self.assertRaises(FeatureError):
            map_category('无效分类')

    def test_search_listing_uses_twenty_item_windows_over_eighty_item_api_pages(self):
        self.assertEqual(listing_page_window(1), (1, 0))
        self.assertEqual(listing_page_window(4), (1, 60))
        self.assertEqual(listing_page_window(5), (2, 0))

    def test_album_page_count_uses_photo_details_when_api_count_is_zero(self):
        from feature_api import FeatureApi

        album = SimpleNamespace(
            page_count='0', episode_list=[('photo-1', '1', '第一话'), ('photo-2', '2', '第二话')]
        )

        class FakeClient:
            def get_photo_detail(self, photo_id, fetch_album, fetch_scramble_id):
                self_requested.append((photo_id, fetch_album, fetch_scramble_id))
                return [None] * {'photo-1': 3, 'photo-2': 5}[photo_id]

        self_requested = []
        api = object.__new__(FeatureApi)
        self.assertEqual(api._page_count(FakeClient(), album, {}), 8)
        self.assertEqual(self_requested, [
            ('photo-1', False, False), ('photo-2', False, False)
        ])

        self.assertEqual(api._page_count(FakeClient(), album, {'total_photos': '12'}), 12)

    def test_feature_routes_register_expected_methods_and_json_envelopes(self):
        from feature_api import FeatureApi

        class FakeApp:
            def __init__(self):
                self.rules = {}

            def add_url_rule(self, rule, endpoint, view_func, methods):
                self.rules[rule] = {'endpoint': endpoint, 'view_func': view_func, 'methods': methods}

        fake_app = FakeApp()
        api = FeatureApi(fake_app, None, 'long', 'pdf', 'zip', None, None, 'auth.json')
        previous_flask = sys.modules.get('flask')
        fake_flask = SimpleNamespace(
            jsonify=lambda payload: payload,
            request=SimpleNamespace(get_json=lambda silent: ['not', 'an', 'object'])
        )
        sys.modules['flask'] = fake_flask
        try:
            api.register_routes()
            self.assertEqual(fake_app.rules['/search']['methods'], ['GET'])
            self.assertEqual(fake_app.rules['/favorite']['methods'], ['POST'])
            self.assertEqual(fake_app.rules['/unfavorite']['methods'], ['POST'])
            self.assertEqual(fake_app.rules['/login']['methods'], ['POST'])
            self.assertEqual(fake_app.rules['/login/status']['methods'], ['GET'])
            self.assertEqual(fake_app.rules['/favorites']['methods'], ['GET'])

            success = api._wrap(lambda: {'value': 7})()
            self.assertEqual(success, {'ok': True, 'value': 7})
            failure = api._wrap(lambda: (_ for _ in ()).throw(FeatureError('参数无效', 400)))()
            self.assertEqual(failure, ({'ok': False, 'error': '参数无效'}, 400))

            invalid_favorite_body = api._wrap(api.favorite)()
            self.assertEqual(invalid_favorite_body, (
                {'ok': False, 'error': '请求格式无效，请提供专辑车号'}, 400
            ))

            fake_flask.request.get_json = lambda silent: {
                'username': 'offline-user', 'password': 'offline-password'
            }
            api._get_client = lambda: object()
            api._perform_login = lambda *args, **kwargs: (_ for _ in ()).throw(
                RuntimeError('offline-password must not be returned')
            )
            login_failure = api._wrap(api.login)()
            self.assertEqual(login_failure[1], 401)
            self.assertNotIn('offline-password', str(login_failure[0]))
        finally:
            if previous_flask is None:
                sys.modules.pop('flask', None)
            else:
                sys.modules['flask'] = previous_flask

    def test_saved_auth_file_uses_owner_only_permissions(self):
        from feature_api import FeatureApi

        with tempfile.TemporaryDirectory(prefix='jm-auth-test-') as temp_dir:
            auth_path = Path(temp_dir) / 'jm-auth.json'
            api = object.__new__(FeatureApi)
            api.auth_path = str(auth_path)
            api._save_auth({'username': 'offline-user', 'password': 'offline-password', 'cookies': {}})
            self.assertEqual(stat.S_IMODE(auth_path.stat().st_mode), 0o600)
            self.assertIn('offline-password', auth_path.read_text(encoding='utf-8'))

    def test_comment_fixture_parses_html_spoilers_and_nested_replies(self):
        fixture = {
            'total': '2',
            'list': [{
                'username': '甲',
                'content': '<p>评论&nbsp;正文</p>',
                'time': '2026-11-13',
                'like': '7',
                'is_spoiler': 1,
                'replys': [{
                    'user': {'name': '乙'},
                    'content': '<br>回复内容',
                    'replies': []
                }]
            }]
        }

        parsed = parse_comments_payload(fixture)
        self.assertEqual(parsed['total'], 2)
        self.assertEqual(parsed['page_count'], 1)
        comment = parsed['comments'][0]
        self.assertEqual(comment['username'], '甲')
        self.assertEqual(comment['content'], '评论 正文')
        self.assertTrue(comment['spoiler'])
        self.assertEqual(comment['replies'][0]['username'], '乙')
        self.assertEqual(comment['replies'][0]['content'], '回复内容')

    def test_comment_parser_rejects_unrecognized_response_without_exposing_html(self):
        with self.assertRaisesRegex(FeatureError, '评论数据解析失败'):
            parse_comments_payload({'html': '<html>' + ('very long' * 1000) + '</html>'})

    def test_chapter_and_zip_paths_are_named_and_separate_from_album_pages(self):
        with tempfile.TemporaryDirectory(prefix='jm-feature-paths-') as temp_dir:
            image_root = Path(temp_dir) / 'long'
            pdf_root = Path(temp_dir) / 'pdf'
            zip_root = Path(temp_dir) / 'zip'
            album_dir = image_root / '123'
            chapter_dir, pdf_path = chapter_output_paths(image_root, pdf_root, 123, 2)
            self.assertEqual(Path(chapter_dir), album_dir / 'ch-2')
            self.assertEqual(Path(pdf_path), pdf_root / '123-ch2.pdf')
            self.assertEqual(Path(zip_output_path(zip_root, 123)), zip_root / '123.zip')

            album_dir.mkdir(parents=True)
            (album_dir / '00001.png').write_bytes(b'album')
            chapter = album_dir / 'ch-2'
            chapter.mkdir()
            (chapter / '00001.png').write_bytes(b'chapter')
            images = list_album_images(album_dir)
            self.assertEqual(images, [str(album_dir / '00001.png')])


if __name__ == '__main__':
    unittest.main()
