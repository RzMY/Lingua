"""Rebuild checked-in application artwork; optional local tool: pip install pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
BG = '#f2f2ea'
GREEN = '#4f7a37'


def icon(size, transparent=False):
    image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0) if transparent else BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((200, 200, 824, 824), radius=156, fill=GREEN)
    for x, top, bottom in [(324, 436, 588), (418, 352, 672), (512, 288, 736), (606, 384, 640), (700, 456, 568)]:
        draw.rounded_rectangle((x - 24, top, x + 24, bottom), radius=24, fill=BG)
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    return image if transparent else image.convert('RGB')


icon(1024).save(ROOT / 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
for density, scale in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]:
    directory = ROOT / f'android/app/src/main/res/mipmap-{density}'
    for name in ['ic_launcher', 'ic_launcher_round']:
        icon(round(48 * scale)).save(directory / f'{name}.png')
    icon(round(108 * scale), True).save(directory / 'ic_launcher_foreground.png')
for path in list((ROOT / 'android/app/src/main/res').glob('drawable*/splash.png')) + list(
        (ROOT / 'ios/App/App/Assets.xcassets/Splash.imageset').glob('*.png')):
    with Image.open(path) as previous:
        size = previous.size
    image = Image.new('RGB', size, BG)
    mark = icon(round(min(size) * .23))
    image.paste(mark, ((size[0] - mark.width) // 2, (size[1] - mark.height) // 2))
    image.save(path)
