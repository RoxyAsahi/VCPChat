"""face.py <dir> <out.png> x0 y0 x1 y1 scale name1 name2 ...  : tile crops (on green) with labels"""
import sys, os
from PIL import Image, ImageDraw
d, out, x0, y0, x1, y1, sc = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7]), float(sys.argv[7])
names = sys.argv[8:]
tiles = []
for n in names:
    p = n if os.path.isabs(n) or os.path.exists(n) else os.path.join(d, n + '.png')
    im = Image.open(p).convert('RGBA').crop((x0, y0, x1, y1))
    bg = Image.new('RGBA', im.size, (0, 160, 0, 255)); bg.alpha_composite(im)
    bg = bg.resize((int(im.width * sc), int(im.height * sc)), Image.LANCZOS).convert('RGB')
    ImageDraw.Draw(bg).text((4, 4), os.path.basename(n), fill=(255, 255, 0)); tiles.append(bg)
cols = min(4, len(tiles)); rows = (len(tiles) + cols - 1) // cols
W, H = tiles[0].size
sheet = Image.new('RGB', (W * cols, H * rows), (0, 0, 0))
for i, t in enumerate(tiles): sheet.paste(t, ((i % cols) * W, (i // cols) * H))
sheet.save(out); print(out, sheet.size)
