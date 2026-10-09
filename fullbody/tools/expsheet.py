# python expsheet.py <dir> : face crops, one row per expression, columns eye0 eye0.3 eye1 | mouth0 mouth0.5 mouth1
import sys, os
from PIL import Image, ImageDraw
d = sys.argv[1]; cols = ['eye0', 'eye0.3', 'eye1', 'mouth0', 'mouth0.5', 'mouth1']
exps = sorted({f.split('_')[0] for f in os.listdir(d) if f.endswith('.png') and not f.startswith('_')})
box = (.3, .4, .7, .64); k = 1
cells = []
for e in exps:
    row = []
    for c in cols:
        im = Image.open(os.path.join(d, f'{e}_{c}.png')).convert('RGB'); w, h = im.size
        cr = im.crop((int(w*box[0]), int(h*box[1]), int(w*box[2]), int(h*box[3])))
        row.append(cr)
    cells.append(row)
cw, ch = cells[0][0].size
S = Image.new('RGB', (90 + cw*6 + 5*6, 20 + (ch+4)*len(exps)), (25, 25, 25)); dr = ImageDraw.Draw(S)
for j, c in enumerate(cols): dr.text((90 + j*(cw+5) + 4, 4), c, fill='white')
for i, e in enumerate(exps):
    dr.text((4, 20 + i*(ch+4) + ch//2), e, fill='white')
    for j, cr in enumerate(cells[i]): S.paste(cr, (90 + j*(cw+5), 20 + i*(ch+4)))
S.save(os.path.join(d, '__expmat.png')); print(S.size)
