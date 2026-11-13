"""Create small JPEG cover previews for the bot's album forward message."""

import os
import sys

from PIL import Image, ImageOps


def create_cover_preview(source_path, output_path, max_width=720, quality=70,
                         max_bytes=2 * 1024 * 1024):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    with Image.open(source_path) as source:
        image = ImageOps.exif_transpose(source).copy()
        if image.width > max_width:
            target_height = max(1, round(image.height * max_width / image.width))
            image.thumbnail((max_width, target_height), Image.Resampling.LANCZOS)

        if image.mode != 'RGB':
            if 'A' in image.getbands() or 'transparency' in image.info:
                rgba = image.convert('RGBA')
                background = Image.new('RGB', rgba.size, 'white')
                background.paste(rgba, mask=rgba.getchannel('A'))
                image = background
            else:
                image = image.convert('RGB')

        qualities = []
        for current_quality in (quality, 60, 50, 40, 30):
            if current_quality not in qualities:
                qualities.append(current_quality)
        for current_quality in qualities:
            image.save(output_path, format='JPEG', quality=current_quality, optimize=True)
            if os.path.getsize(output_path) <= max_bytes:
                image.close()
                return output_path
        image.close()

    if os.path.exists(output_path):
        os.remove(output_path)
    raise ValueError('预览图压缩后仍过大')


def create_page_preview(source_path, output_path, max_width=720, quality=65,
                        max_bytes=1500 * 1024):
    """Create a small JPEG page image for QQ forwarding."""
    try:
        return create_cover_preview(
            source_path, output_path, max_width=max_width, quality=quality, max_bytes=max_bytes
        )
    except ValueError as error:
        raise ValueError('页图压缩后仍过大，请改用 #jm查 获取 PDF') from error


def create_long_preview(source_paths, output_path, max_width=720, quality=55,
                        max_height=30000, max_bytes=8 * 1024 * 1024):
    """Stack pages vertically and save a bounded-size JPEG preview."""
    if not source_paths:
        raise ValueError('没有可拼接的页图')

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    pages = []
    try:
        total_height = 0
        canvas_width = 0
        for source_path in source_paths:
            with Image.open(source_path) as source:
                image = ImageOps.exif_transpose(source).copy()
            if image.width > max_width:
                target_height = max(1, round(image.height * max_width / image.width))
                image.thumbnail((max_width, target_height), Image.Resampling.LANCZOS)
            if image.mode != 'RGB':
                if 'A' in image.getbands() or 'transparency' in image.info:
                    rgba = image.convert('RGBA')
                    background = Image.new('RGB', rgba.size, 'white')
                    background.paste(rgba, mask=rgba.getchannel('A'))
                    image = background
                else:
                    image = image.convert('RGB')
            pages.append(image)
            total_height += image.height
            canvas_width = max(canvas_width, image.width)
            if total_height > max_height or total_height * canvas_width > 20_000_000:
                raise ValueError('长图高度过大，请改用 #jm查 获取 PDF')

        canvas = Image.new('RGB', (canvas_width, total_height), 'white')
        y = 0
        for page in pages:
            x = (canvas_width - page.width) // 2
            canvas.paste(page, (x, y))
            y += page.height
        canvas.save(output_path, format='JPEG', quality=quality, optimize=True)

        if os.path.getsize(output_path) > max_bytes:
            os.remove(output_path)
            raise ValueError('长图压缩后仍超过 8 MB，请改用 #jm查 获取 PDF')
    finally:
        for page in pages:
            page.close()
        if 'canvas' in locals():
            canvas.close()

    return output_path


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('用法：python cover_preview.py <封面路径> <预览输出路径>')
    create_cover_preview(sys.argv[1], sys.argv[2])
