import random
import tempfile
import unittest
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

if Image is not None:
    from pyapi.cover_preview import create_cover_preview, create_long_preview, create_page_preview
else:
    create_cover_preview = None
    create_long_preview = None
    create_page_preview = None


@unittest.skipIf(Image is None, 'Pillow is not installed in this Python environment')
class CoverPreviewTest(unittest.TestCase):
    def test_preview_is_small_jpeg_with_maximum_width_720(self):
        rng = random.Random(20261113)
        width, height = 1800, 1200
        pixels = bytes(rng.randrange(256) for _ in range(width * height * 3))

        with tempfile.TemporaryDirectory(prefix='jm-cover-test-') as temp_dir:
            source_path = Path(temp_dir) / 'large-cover.png'
            preview_path = Path(temp_dir) / 'preview.jpg'
            Image.frombytes('RGB', (width, height), pixels).save(
                source_path, format='PNG', compress_level=0
            )

            create_cover_preview(source_path, preview_path)

            with Image.open(preview_path) as preview:
                self.assertEqual(preview.format, 'JPEG')
                self.assertLessEqual(preview.width, 720)
            self.assertEqual(preview.height, 480)
            self.assertLess(preview_path.stat().st_size, source_path.stat().st_size // 3)

    def test_page_preview_is_small_jpeg(self):
        with tempfile.TemporaryDirectory(prefix='jm-page-test-') as temp_dir:
            source_path = Path(temp_dir) / 'page.png'
            preview_path = Path(temp_dir) / 'page-preview.jpg'
            Image.new('RGB', (1200, 1800), '#123456').save(source_path, format='PNG')

            create_page_preview(source_path, preview_path)

            with Image.open(preview_path) as preview:
                self.assertEqual(preview.format, 'JPEG')
                self.assertEqual(preview.width, 720)
                self.assertEqual(preview.height, 1080)
            self.assertLess(preview_path.stat().st_size, source_path.stat().st_size)

    def test_long_preview_stacks_pages_and_obeys_size_limits(self):
        with tempfile.TemporaryDirectory(prefix='jm-long-test-') as temp_dir:
            source_paths = []
            for index, color in enumerate(('#123456', '#abcdef'), start=1):
                source_path = Path(temp_dir) / f'{index}.png'
                Image.new('RGB', (1200, 1800), color).save(source_path, format='PNG')
                source_paths.append(source_path)
            output_path = Path(temp_dir) / 'long.jpg'

            create_long_preview(source_paths, output_path)

            with Image.open(output_path) as preview:
                self.assertEqual(preview.format, 'JPEG')
                self.assertEqual(preview.width, 720)
                self.assertEqual(preview.height, 2160)
            self.assertLessEqual(output_path.stat().st_size, 8 * 1024 * 1024)

    def test_long_preview_rejects_too_high_output(self):
        with tempfile.TemporaryDirectory(prefix='jm-long-limit-test-') as temp_dir:
            source_path = Path(temp_dir) / 'page.png'
            output_path = Path(temp_dir) / 'long.jpg'
            Image.new('RGB', (720, 200), '#123456').save(source_path, format='PNG')

            with self.assertRaisesRegex(ValueError, '高度过大'):
                create_long_preview([source_path], output_path, max_height=100)
            self.assertFalse(output_path.exists())


if __name__ == '__main__':
    unittest.main()
