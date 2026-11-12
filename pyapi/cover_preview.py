"""Create small JPEG cover previews for the bot's album forward message."""

import os
import sys

from PIL import Image, ImageOps


def create_cover_preview(source_path, output_path, max_width=720, quality=70):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    with Image.open(source_path) as source:
        image = ImageOps.exif_transpose(source)
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

        image.save(output_path, format='JPEG', quality=quality, optimize=True)

    return output_path


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('用法：python cover_preview.py <封面路径> <预览输出路径>')
    create_cover_preview(sys.argv[1], sys.argv[2])
