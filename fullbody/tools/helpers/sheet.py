import sys, os, glob
from PIL import Image, ImageDraw
import numpy as np
d = sys.argv[1]; files = sorted(glob.glob(os.path.join(d, '*.png')))
files = [f for f in files if not f.endswith('sheet.png')]
tw, th = 210, 504; cols = 7
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * (th + 22)), (28, 28, 34))
dr = ImageDraw.Draw(sheet); gaps = []
for i, f in enumerate(files):
    im = Image.open(f).convert('RGBA'); a = np.asarray(im)[..., 3]
    gap = im.height - 1 - np.where(a.max(1) > 0)[0].max(); gaps.append(gap)
    bg = Image.new('RGBA', im.size, (40, 40, 48, 255)); bg.alpha_composite(im)
    x, y = (i % cols) * tw, (i // cols) * (th + 22)
    sheet.paste(bg.convert('RGB').resize((tw, th), Image.LANCZOS), (x, y + 22))
    dr.text((x + 4, y + 4), f'{os.path.basename(f)[:-4]}  gap={gap}', fill=(230, 230, 230))
sheet.save(os.path.join(d, 'sheet.png'))
print(d, len(files), 'feet gap max', max(gaps), 'min', min(gaps))
