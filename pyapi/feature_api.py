"""Flask feature routes for the Node command layer."""

import html
import json
import logging
import math
import os
import re
import threading
import zipfile
from html.parser import HTMLParser


PAGE_SIZE = 20
SEARCH_API_PAGE_SIZE = 80
IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp', '.gif')


class FeatureError(Exception):
    def __init__(self, message, status=400, extra=None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


def parse_feature_id(raw):
    normalized = ''.join(str(raw or '').split())
    if normalized[:2].lower() == 'jm':
        normalized = normalized[2:]
    if not normalized.isascii() or not normalized.isdigit():
        return None
    value = int(normalized)
    if value <= 0 or value > 9007199254740991:
        return None
    return value


def parse_positive_int(raw, name='页码', default=None):
    if raw is None or str(raw).strip() == '':
        return default
    text = str(raw).strip()
    if not text.isascii() or not text.isdigit():
        raise FeatureError(f'{name}必须是正整数')
    value = int(text)
    if value <= 0 or value > 1000000:
        raise FeatureError(f'{name}必须是正整数')
    return value


def _jm_constant(name, fallback):
    try:
        from jmcomic.jm_config import JmMagicConstants
        return getattr(JmMagicConstants, name)
    except (ImportError, AttributeError):
        return fallback


CATEGORY_FIELDS = {
    '全部': ('CATEGORY_ALL', '0'), 'all': ('CATEGORY_ALL', '0'), '0': ('CATEGORY_ALL', '0'),
    '同人': ('CATEGORY_DOUJIN', 'doujin'), 'doujin': ('CATEGORY_DOUJIN', 'doujin'),
    '单本': ('CATEGORY_SINGLE', 'single'), 'single': ('CATEGORY_SINGLE', 'single'),
    '短篇': ('CATEGORY_SHORT', 'short'), 'short': ('CATEGORY_SHORT', 'short'),
    '其他': ('CATEGORY_ANOTHER', 'another'), 'other': ('CATEGORY_ANOTHER', 'another'),
    '韩漫': ('CATEGORY_HANMAN', 'hanman'), 'hanman': ('CATEGORY_HANMAN', 'hanman'),
    '美漫': ('CATEGORY_MEIMAN', 'meiman'), 'meiman': ('CATEGORY_MEIMAN', 'meiman'),
    '英文': ('CATEGORY_ENGLISH_SITE', 'english_site'), 'english': ('CATEGORY_ENGLISH_SITE', 'english_site'),
    '英文站': ('CATEGORY_ENGLISH_SITE', 'english_site'), 'english_site': ('CATEGORY_ENGLISH_SITE', 'english_site'),
    '3d': ('CATEGORY_3D', '3D'),
    'cosplay': ('CATEGORY_DOUJIN_COSPLAY', 'doujin_cosplay'),
    'cos': ('CATEGORY_DOUJIN_COSPLAY', 'doujin_cosplay')
}

ORDER_FIELDS = {
    '最新': ('ORDER_BY_LATEST', 'mr'), 'latest': ('ORDER_BY_LATEST', 'mr'), 'mr': ('ORDER_BY_LATEST', 'mr'),
    '观看': ('ORDER_BY_VIEW', 'mv'), 'view': ('ORDER_BY_VIEW', 'mv'), 'mv': ('ORDER_BY_VIEW', 'mv'),
    '点赞': ('ORDER_BY_LIKE', 'tf'), 'like': ('ORDER_BY_LIKE', 'tf'), 'tf': ('ORDER_BY_LIKE', 'tf'),
    '评分': ('ORDER_BY_SCORE', 'tr'), 'score': ('ORDER_BY_SCORE', 'tr'), 'tr': ('ORDER_BY_SCORE', 'tr'),
    '图片': ('ORDER_BY_PICTURE', 'mp'), 'picture': ('ORDER_BY_PICTURE', 'mp'), 'mp': ('ORDER_BY_PICTURE', 'mp'),
    '评论': ('ORDER_BY_COMMENT', 'md'), 'comment': ('ORDER_BY_COMMENT', 'md'), 'md': ('ORDER_BY_COMMENT', 'md')
}

TIME_FIELDS = {
    '今天': ('TIME_TODAY', 't'), '日': ('TIME_TODAY', 't'), 'today': ('TIME_TODAY', 't'), 't': ('TIME_TODAY', 't'),
    '一周': ('TIME_WEEK', 'w'), '周': ('TIME_WEEK', 'w'), 'week': ('TIME_WEEK', 'w'), 'w': ('TIME_WEEK', 'w'),
    '本月': ('TIME_MONTH', 'm'), '月': ('TIME_MONTH', 'm'), 'month': ('TIME_MONTH', 'm'), 'm': ('TIME_MONTH', 'm'),
    '全部': ('TIME_ALL', 'a'), 'all': ('TIME_ALL', 'a'), 'a': ('TIME_ALL', 'a')
}


def _map_value(raw, fields, label, default_key=None, available=''):
    value = str(raw or '').strip()
    if not value and default_key is not None:
        value = default_key
    mapping = fields.get(value.lower(), fields.get(value))
    if mapping is None:
        raise FeatureError(f'{label}无效，可用值：{available}')
    constant_name, fallback = mapping
    return _jm_constant(constant_name, fallback)


def map_category(raw='全部'):
    return _map_value(raw, CATEGORY_FIELDS, '分类', '全部', '全部、同人、单本、短篇、韩漫、美漫、英文、其他、3D、cosplay')


def map_order(raw='最新'):
    return _map_value(raw, ORDER_FIELDS, '排序', '最新', '最新、观看、点赞、评分、图片、评论')


def map_time(raw='全部'):
    return _map_value(raw, TIME_FIELDS, '时间', '全部', '今天、一周、本月、全部')


def map_ranking_period(raw='周'):
    values = {
        '日': 'day', 'day': 'day', '周': 'week', 'week': 'week', '月': 'month', 'month': 'month'
    }
    period = values.get(str(raw or '').strip().lower(), values.get(str(raw or '').strip()))
    if period is None:
        raise FeatureError('排行时间无效，可用值：日、周、月')
    return period


def listing_page_window(page, upstream_page_size=SEARCH_API_PAGE_SIZE):
    start = (page - 1) * PAGE_SIZE
    return start // upstream_page_size + 1, start % upstream_page_size


def chapter_output_paths(image_folder, pdf_folder, jm_id, chapter):
    chapter_dir = os.path.abspath(os.path.join(image_folder, str(jm_id), f'ch-{chapter}'))
    pdf_path = os.path.abspath(os.path.join(pdf_folder, f'{jm_id}-ch{chapter}.pdf'))
    return chapter_dir, pdf_path


def zip_output_path(zip_folder, jm_id):
    return os.path.abspath(os.path.join(zip_folder, f'{jm_id}.zip'))


def list_album_images(album_dir):
    """List whole-book pages while excluding isolated chapter downloads."""
    images = []
    if not os.path.isdir(album_dir):
        return images
    for root, dirs, files in os.walk(album_dir):
        dirs[:] = sorted(directory for directory in dirs if not re.fullmatch(r'ch-\d+', directory, re.I))
        for filename in sorted(files):
            if filename.lower().endswith(IMAGE_EXTENSIONS):
                images.append(os.path.abspath(os.path.join(root, filename)))
    return images


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() in ('br', 'p', 'div', 'li'):
            self.parts.append(' ')

    def handle_data(self, data):
        self.parts.append(data)


def strip_comment_html(value):
    source = html.unescape(str(value or ''))
    parser = _HTMLText()
    try:
        parser.feed(source)
        text = ''.join(parser.parts)
    except Exception:
        text = re.sub(r'<[^>]*>', ' ', source)
    return re.sub(r'\s+', ' ', text).strip()


def _first(mapping, keys, default=None):
    if not isinstance(mapping, dict):
        return default
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != '':
            return value
    return default


def _spoiler(value):
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'y', 'spoiler', '剧透')


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'y', 'on')


def _normalize_comment(comment):
    if not isinstance(comment, dict):
        return None
    user = _first(comment, ('username', 'user_name', 'uname', 'name', 'user'), '匿名')
    if isinstance(user, dict):
        user = _first(user, ('username', 'name', 'nickname', 'uname'), '匿名')
    content = _first(comment, ('content', 'comment', 'text', 'txt', 'body'), '')
    replies = _first(comment, ('replys', 'replies', 'reply_list', 'children'), [])
    if isinstance(replies, dict):
        replies = replies.get('list', replies.get('replys', []))
    if not isinstance(replies, list):
        replies = []
    normalized_replies = [item for item in (_normalize_comment(reply) for reply in replies) if item]
    return {
        'username': strip_comment_html(user),
        'time': strip_comment_html(_first(comment, ('time', 'date', 'created_at', 'addtime', 'datetime'), '')),
        'content': strip_comment_html(content),
        'likes': _first(comment, ('likes', 'like', 'like_count', 'agree', 'thumbs_up')),
        'spoiler': _spoiler(_first(comment, ('is_spoiler', 'spoiler', 'isSpoiler', 'spoiler_tag'), False)),
        'replies': normalized_replies
    }


def _comment_list(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return None
    for key in ('list', 'comments', 'comment_list', 'forum_list', 'data'):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            nested = _comment_list(value)
            if nested is not None:
                return nested
    return None


def parse_comments_payload(payload, page_size=PAGE_SIZE):
    raw_comments = _comment_list(payload)
    if raw_comments is None:
        raise FeatureError('评论数据解析失败，接口没有返回评论列表', 502)
    comments = [item for item in (_normalize_comment(comment) for comment in raw_comments) if item]
    total_raw = _first(payload, ('total', 'count', 'comment_total', 'total_count')) if isinstance(payload, dict) else None
    try:
        total = int(total_raw) if total_raw is not None else None
    except (TypeError, ValueError):
        total = None
    page_count = math.ceil(total / page_size) if total is not None and total > 0 else (0 if total == 0 else None)
    return {'comments': comments, 'total': total, 'page_count': page_count, 'page_size': page_size}


class FeatureApi:
    def __init__(self, app, get_option, image_folder, pdf_folder, zip_folder,
                 download_album, pdf_builder, auth_path):
        self.app = app
        self.get_option = get_option
        self.image_folder = os.path.abspath(image_folder)
        self.pdf_folder = os.path.abspath(pdf_folder)
        self.zip_folder = os.path.abspath(zip_folder)
        self.download_album = download_album
        self.pdf_builder = pdf_builder
        self.auth_path = os.path.abspath(auth_path)
        self._lock = threading.RLock()
        self._auth_loaded = False
        self._auth_attempted = False
        self._auth_data = None
        self._logged_in = False
        self._client = None

    def register_routes(self):
        routes = [
            ('/search', self.search),
            ('/tag', self.search_tag),
            ('/album_info', self.album_info),
            ('/ranking', self.ranking),
            ('/category', self.category),
            ('/comments', self.comments),
            ('/chapter', self.chapter),
            ('/zip', self.zip_album),
            ('/longimg', self.long_image),
            ('/pages', self.pages),
            ('/login/status', self.login_status),
            ('/favorites', self.favorites),
            ('/favorite', self.favorite),
            ('/unfavorite', self.unfavorite),
            ('/like_status', self.like_status)
        ]
        for route, action in routes:
            methods = ['POST'] if route in ('/favorite', '/unfavorite') else ['GET']
            if route == '/login/status':
                methods = ['GET']
            if route == '/favorite' or route == '/unfavorite':
                methods = ['POST']
            self.app.add_url_rule(
                route,
                endpoint=f'jm_feature_{route.strip("/").replace("/", "_")}',
                view_func=self._wrap(action, log_failure=route != '/login/status'),
                methods=methods
            )
        self.app.add_url_rule(
            '/login', endpoint='jm_feature_login', view_func=self._wrap(self.login, log_failure=False), methods=['POST']
        )

    def initialize_auth(self):
        try:
            self._get_client()
        except Exception:
            logging.warning('JM 登录信息初始化失败，收藏功能暂不可用')

    def _wrap(self, action, log_failure=True):
        from flask import jsonify

        def wrapped():
            try:
                result = action()
                return jsonify({'ok': True, **(result or {})})
            except FeatureError as error:
                return jsonify({'ok': False, 'error': str(error), **error.extra}), error.status
            except Exception:
                if log_failure:
                    logging.exception('JM 新功能接口处理失败')
                return jsonify({'ok': False, 'error': '请求处理失败，请稍后重试'}), 500
        wrapped.__name__ = f'jm_feature_{action.__name__}'
        return wrapped

    def _load_auth(self):
        with self._lock:
            if self._auth_loaded:
                return
            self._auth_loaded = True
            try:
                with open(self.auth_path, 'r', encoding='utf-8') as file:
                    self._auth_data = json.load(file)
            except FileNotFoundError:
                self._auth_data = None
            except Exception:
                logging.warning('JM 登录配置读取失败')
                self._auth_data = None

            cookies = self._auth_data.get('cookies') if isinstance(self._auth_data, dict) else None
            if isinstance(cookies, dict) and cookies:
                try:
                    self.get_option().update_cookies(cookies)
                    self._logged_in = True
                except Exception:
                    self._logged_in = False

    def _new_client(self):
        try:
            from jmcomic import JmApiClient
            return self.get_option().new_jm_client(impl=JmApiClient)
        except Exception as error:
            raise FeatureError('JM API 客户端初始化失败，请检查后端配置', 503) from error

    def _get_client(self):
        self._load_auth()
        with self._lock:
            if self._client is None:
                self._client = self._new_client()
            auth = self._auth_data if isinstance(self._auth_data, dict) else {}
            username = str(auth.get('username') or '')
            password = str(auth.get('password') or '')
            if username and password and not self._auth_attempted:
                self._auth_attempted = True
                try:
                    self._perform_login(username, password, persist=True, client=self._client)
                except Exception:
                    self._logged_in = False
                    logging.warning('JM 登录信息自动登录失败，收藏功能暂不可用')
            return self._client

    def _save_auth(self, data):
        os.makedirs(os.path.dirname(self.auth_path), exist_ok=True)
        file_descriptor = os.open(self.auth_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(file_descriptor, 'w', encoding='utf-8') as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.write('\n')
            os.chmod(self.auth_path, 0o600)
        except Exception:
            try:
                os.close(file_descriptor)
            except OSError:
                pass
            raise

    def _perform_login(self, username, password, persist, client=None):
        client = client or self._get_client()
        response = client.login(username, password)
        raw = response.res_data
        cookies = dict(response.resp.cookies)
        avs = raw.get('s') if isinstance(raw, dict) else None
        if avs:
            cookies['AVS'] = avs
        if not cookies:
            raise ValueError('登录响应未返回 cookies')

        self.get_option().update_cookies(cookies)
        self._logged_in = True
        self._auth_attempted = True
        self._auth_data = {'username': username, 'password': password, 'cookies': cookies}
        if persist:
            self._save_auth(self._auth_data)

    def _require_login(self):
        client = self._get_client()
        if not self._logged_in:
            raise FeatureError('未登录，请私聊主人发送 #jm登录 账号 密码', 401)
        return client

    @staticmethod
    def _jm_id_from_args():
        from flask import request
        jm_id = parse_feature_id(request.args.get('jm', ''))
        if jm_id is None:
            raise FeatureError('参数 jm 必须为正整数')
        return jm_id

    @staticmethod
    def _listing_payload(page_obj, requested_page, source_page, offset, source_size=SEARCH_API_PAGE_SIZE):
        try:
            total = max(0, int(page_obj.total))
        except (AttributeError, TypeError, ValueError):
            total = 0
        if hasattr(page_obj, 'iter_id_title_tag'):
            source_items = list(page_obj.iter_id_title_tag())
        else:
            source_items = list(page_obj)
        items = [
            {'id': str(jm_id), 'title': str(title), 'tags': list(tags or [])}
            for jm_id, title, tags in source_items[offset:offset + PAGE_SIZE]
        ]
        page_count = max(1, math.ceil(total / PAGE_SIZE))
        return {
            'page': requested_page,
            'page_count': page_count,
            'page_size': PAGE_SIZE,
            'total': total,
            'items': items
        }

    @staticmethod
    def _page_arg():
        from flask import request
        return parse_positive_int(request.args.get('page'), '页码', 1)

    def search(self):
        from flask import request
        query = str(request.args.get('q', '')).strip()
        if not query:
            raise FeatureError('请输入搜索关键词')
        page = self._page_arg()
        api_page, offset = listing_page_window(page)
        client = self._get_client()
        result = client.search_site(query, page=api_page)
        return self._listing_payload(result, page, api_page, offset)

    def search_tag(self):
        from flask import request
        tag = str(request.args.get('tag', '')).strip()
        if not tag:
            raise FeatureError('请输入标签')
        page = self._page_arg()
        api_page, offset = listing_page_window(page)
        result = self._get_client().search_tag(tag, page=api_page)
        return self._listing_payload(result, page, api_page, offset)

    def _raw_album(self, client, jm_id):
        url = client.append_params_to_url('/album', {'id': str(jm_id)})
        return client.req_api(url).res_data

    def _page_count(self, client, album, raw):
        for key in ('total_photos', 'total_photo', 'total_pages', 'page_count'):
            try:
                value = int(raw.get(key) or 0)
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass
        try:
            value = int(album.page_count)
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass

        # 2.6.13 可能把 album.page_count 固定为 0；仅在原始专辑字段缺失时
        # 逐章读取 photo detail 的页数，不触发图片下载。
        total = 0
        try:
            for photo_id, _, _ in album.episode_list:
                photo = client.get_photo_detail(
                    photo_id, fetch_album=False, fetch_scramble_id=False
                )
                photo_pages = len(photo)
                if photo_pages <= 0:
                    return None
                total += photo_pages
        except Exception:
            return None
        return total or None

    def album_info(self):
        jm_id = self._jm_id_from_args()
        client = self._get_client()
        album = client.get_album_detail(jm_id)
        raw = self._raw_album(client, jm_id)
        episodes = []
        for photo_id, sort, title in album.episode_list:
            try:
                index = int(sort)
            except (TypeError, ValueError):
                continue
            episodes.append({'index': index, 'photo_id': str(photo_id), 'title': str(title)})
        episodes.sort(key=lambda item: item['index'])
        result = {
            'jm': str(jm_id), 'title': album.name, 'authors': list(album.authors or []),
            'tags': list(album.tags or []), 'actors': list(album.actors or []), 'works': list(album.works or []),
            'page_count': self._page_count(client, album, raw), 'episodes': episodes,
            'likes': str(album.likes), 'views': str(album.views), 'comment_count': int(album.comment_count),
            'description': str(album.description or '')[:1200], 'logged_in': bool(self._logged_in)
        }
        if self._logged_in:
            result['liked'] = _as_bool(raw.get('liked', False))
            result['is_favorite'] = _as_bool(raw.get('is_favorite', False))
        return result

    def ranking(self):
        from flask import request
        period = map_ranking_period(request.args.get('period', '周'))
        category = map_category(request.args.get('category', '全部'))
        page = self._page_arg()
        api_page, offset = listing_page_window(page)
        client = self._get_client()
        method = {'day': client.day_ranking, 'week': client.week_ranking, 'month': client.month_ranking}[period]
        result = method(page=api_page, category=category)
        payload = self._listing_payload(result, page, api_page, offset)
        payload['period'] = period
        return payload

    def category(self):
        from flask import request
        category = map_category(request.args.get('category', '全部'))
        order = map_order(request.args.get('order', '最新'))
        time = map_time(request.args.get('time', '全部'))
        page = self._page_arg()
        api_page, offset = listing_page_window(page)
        result = self._get_client().categories_filter(api_page, time, category, order)
        return self._listing_payload(result, page, api_page, offset)

    def comments(self):
        from flask import request
        jm_id = self._jm_id_from_args()
        page = self._page_arg()
        client = self._get_client()
        try:
            response = client.req_api('/forum', params={'mode': 'all', 'page': page, 'aid': jm_id})
            payload = parse_comments_payload(response.res_data)
        except FeatureError:
            raise
        except Exception as error:
            raise FeatureError('评论暂时获取失败，请稍后重试', 503) from error
        payload.update({'jm': str(jm_id), 'page': page})
        return payload

    @staticmethod
    def _chapter_list(album):
        return [
            {'index': int(sort), 'photo_id': str(photo_id), 'title': str(title)}
            for photo_id, sort, title in album.episode_list
        ]

    def chapter(self):
        from flask import request
        from cover_preview import create_cover_preview
        jm_id = self._jm_id_from_args()
        chapter = parse_positive_int(request.args.get('chapter'), '章节序号')
        client = self._get_client()
        album = client.get_album_detail(jm_id)
        episode = next((item for item in album.episode_list if str(item[1]) == str(chapter)), None)
        if episode is None:
            chapters = self._chapter_list(album)
            available = '；'.join(f"第{item['index']}话 {item['title']} (photo_id={item['photo_id']})" for item in chapters[:30])
            if len(chapters) > 30:
                available += '；其余章节略'
            raise FeatureError(
                f'未找到第{chapter}话。可用章节：{available or "暂无章节"}',
                404,
                {'chapters': chapters}
            )

        photo_id = str(episode[0])
        chapter_dir, pdf_path = chapter_output_paths(self.image_folder, self.pdf_folder, jm_id, chapter)
        os.makedirs(chapter_dir, exist_ok=True)
        option = self.get_option().copy_option()
        old_rule = option.dir_rule
        option.dir_rule = old_rule.__class__(rule='Bd', base_dir=chapter_dir, normalize_zh=old_rule.normalize_zh)
        option.plugins = {}
        try:
            import jmcomic
            jmcomic.download_photo(photo_id, option)
        except Exception as error:
            raise FeatureError(f'第{chapter}话下载失败，请稍后重试', 503) from error

        images = self._directory_images(chapter_dir)
        if not images:
            raise FeatureError(f'第{chapter}话下载后没有找到页图', 404)
        try:
            if self.pdf_builder(images, pdf_path) is False or not os.path.isfile(pdf_path):
                raise ValueError('PDF 文件未生成')
            preview_path = os.path.abspath(os.path.join(self.pdf_folder, f'{jm_id}-ch{chapter}.cover-preview.jpg'))
            create_cover_preview(images[0], preview_path)
        except Exception as error:
            raise FeatureError(f'第{chapter}话 PDF 合成失败', 500) from error
        return {
            'jm': str(jm_id), 'chapter': chapter, 'title': str(episode[2]), 'photo_id': photo_id,
            'page_count': len(images), 'pdf_path': pdf_path, 'pdf_size': os.path.getsize(pdf_path),
            'cover_preview_path': preview_path
        }

    @staticmethod
    def _directory_images(directory):
        images = []
        for root, dirs, files in os.walk(directory):
            dirs.sort()
            for filename in sorted(files):
                if filename.lower().endswith(IMAGE_EXTENSIONS):
                    images.append(os.path.abspath(os.path.join(root, filename)))
        return images

    def _ensure_album_images(self, jm_id):
        album_dir = os.path.join(self.image_folder, str(jm_id))
        images = list_album_images(album_dir)
        if not images:
            if not self.download_album(jm_id):
                raise FeatureError('整本下载失败，请稍后重试', 503)
            images = list_album_images(album_dir)
        if not images:
            raise FeatureError('下载后仍未找到专辑页图', 404)
        return album_dir, images

    def zip_album(self):
        from flask import request
        jm_id = self._jm_id_from_args()
        album_dir, images = self._ensure_album_images(jm_id)
        os.makedirs(self.zip_folder, exist_ok=True)
        zip_path = zip_output_path(self.zip_folder, jm_id)
        try:
            with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for image in images:
                    archive.write(image, arcname=os.path.relpath(image, album_dir))
        except Exception as error:
            raise FeatureError('ZIP 压缩失败，请检查后端日志', 500) from error
        return {'jm': str(jm_id), 'zip_path': zip_path, 'zip_size': os.path.getsize(zip_path), 'file_name': f'{jm_id}.zip'}

    def long_image(self):
        from flask import request
        from cover_preview import create_long_preview
        jm_id = self._jm_id_from_args()
        _, images = self._ensure_album_images(jm_id)
        os.makedirs(self.pdf_folder, exist_ok=True)
        output_path = os.path.abspath(os.path.join(self.pdf_folder, f'{jm_id}.long-preview.jpg'))
        try:
            create_long_preview(images, output_path)
        except ValueError as error:
            raise FeatureError(str(error), 413) from error
        except Exception as error:
            raise FeatureError('长图生成失败，请稍后重试', 500) from error
        return {'jm': str(jm_id), 'image_path': output_path, 'image_size': os.path.getsize(output_path)}

    def pages(self):
        from flask import request
        from cover_preview import create_page_preview
        jm_id = self._jm_id_from_args()
        limit = parse_positive_int(request.args.get('limit'), '页数上限', 20)
        if limit > 100:
            raise FeatureError('页数上限不能超过 100')
        _, images = self._ensure_album_images(jm_id)
        preview_dir = os.path.abspath(os.path.join(self.pdf_folder, f'{jm_id}.pages'))
        os.makedirs(preview_dir, exist_ok=True)
        previews = []
        for index, image in enumerate(images[:limit], start=1):
            output_path = os.path.join(preview_dir, f'{index:03d}.jpg')
            try:
                create_page_preview(image, output_path)
            except ValueError as error:
                raise FeatureError(str(error), 413) from error
            previews.append({'index': index, 'path': os.path.abspath(output_path), 'size': os.path.getsize(output_path)})
        return {
            'jm': str(jm_id), 'page_count': len(images), 'limit': limit,
            'truncated': len(images) > limit, 'previews': previews
        }

    def login_status(self):
        self._get_client()
        configured = bool(isinstance(self._auth_data, dict) and (self._auth_data.get('username') or self._auth_data.get('cookies')))
        return {'configured': configured, 'logged_in': bool(self._logged_in)}

    def login(self):
        from flask import request
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise FeatureError('请求格式无效，请提供账号和密码')
        username = str(payload.get('username') or '').strip()
        password = str(payload.get('password') or '')
        if not username or not password:
            raise FeatureError('账号和密码不能为空')
        client = self._get_client()
        try:
            self._perform_login(username, password, persist=True, client=client)
        except Exception:
            self._logged_in = False
            self._auth_attempted = True
            raise FeatureError('登录失败，请检查账号密码或稍后重试', 401)
        return {'configured': True, 'logged_in': True}

    def favorites(self):
        from flask import request
        client = self._require_login()
        page = self._page_arg()
        result = client.favorite_folder(page=page)
        return self._listing_payload(result, page, page, 0, source_size=PAGE_SIZE)

    def _toggle_favorite(self, desired):
        from flask import request
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise FeatureError('请求格式无效，请提供专辑车号')
        jm_id = parse_feature_id(payload.get('jm'))
        if jm_id is None:
            raise FeatureError('参数 jm 必须为正整数')
        client = self._require_login()
        raw = self._raw_album(client, jm_id)
        current = _as_bool(raw.get('is_favorite', False))
        if current == desired:
            return {'jm': str(jm_id), 'is_favorite': current, 'changed': False}

        try:
            response = client.add_favorite_album(jm_id)
            action_type = str(response.res_data.get('type', '')).lower()
            expected_type = 'add' if desired else 'remove'
            confirmed = action_type == expected_type
            if not confirmed:
                raw = self._raw_album(client, jm_id)
                confirmed = _as_bool(raw.get('is_favorite', False)) == desired
            if not confirmed:
                raise FeatureError('收藏操作未确认，请稍后查看收藏状态', 502)
        except FeatureError:
            raise
        except Exception as error:
            raise FeatureError('收藏操作失败，请稍后重试', 503) from error
        return {'jm': str(jm_id), 'is_favorite': desired, 'changed': True}

    def favorite(self):
        return self._toggle_favorite(True)

    def unfavorite(self):
        return self._toggle_favorite(False)

    def like_status(self):
        jm_id = self._jm_id_from_args()
        client = self._require_login()
        raw = self._raw_album(client, jm_id)
        if 'liked' not in raw or 'is_favorite' not in raw:
            raise FeatureError('专辑接口没有返回点赞/收藏状态', 502)
        return {'jm': str(jm_id), 'liked': _as_bool(raw['liked']), 'is_favorite': _as_bool(raw['is_favorite'])}
