import os, sys
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]
tags = ['01_tech', '02_maid', '03_chibi', '04_tech']
kinds = ['page', 'eyes0_mouth1', 'gaze_left']
f = ImageFont.truetype(r'C:\Windows\Fonts\msyh.ttc', 16)
cells = []
for t in tags:
    row = []
    for k in kinds:
        im = Image.open(os.path.join(d, f'{t}_{k}.png' if k != 'page' else f'{t}_page.png')).convert('RGBA')
        bg = Image.new('RGBA', im.size, (236, 238, 242, 255)); im = Image.alpha_composite(bg, im).convert('RGB')
        s = 520 / im.height; row.append((f'{t} {k}', im.resize((round(im.width * s), 520))))
    cells.append(row)
W = sum(max(r[i][1].width for r in cells) + 10 for i in range(3)) * 0 
colw = [max(r[i][1].width for r in cells) for i in range(3)]
rowh = 520 + 26
sheet = Image.new('RGB', (len(tags) * (sum(colw) + 40), rowh + 40), 'white')
dr = ImageDraw.Draw(sheet)
x = 10
for r in cells:
    for i, (lab, im) in enumerate(r):
        dr.rectangle([x - 1, 33, x + im.width, 34 + im.height], outline=(200, 60, 60))
        sheet.paste(im, (x, 34)); dr.text((x, 6), lab, fill='black', font=f); x += colw[i] + 10
    x += 20
sheet.save(sys.argv[2])
