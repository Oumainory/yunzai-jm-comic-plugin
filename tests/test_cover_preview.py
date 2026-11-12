import random
import tempfile
import unittest
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

if Image is not None:
    from pyapi.cover_preview import create_cover_preview
else:
    create_cover_preview = None


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


if __name__ == '__main__':
    unittest.main()
