"""contact sheets per shot group + 2x zoom crops. usage: sheet2.py <acc dir> <head frac> <hands lo> <hands hi>"""
import sys, os, glob
from PIL import Image, ImageDraw
import numpy as np
d = sys.argv[1]; head = float(sys.argv[2]); hlo, hhi = float(sys.argv[3]), float(sys.argv[4])
BG = (40, 40, 48, 255)
def load(f):
    im = Image.open(f).convert('RGBA'); bg = Image.new('RGBA', im.size, BG); bg.alpha_composite(im); return im, bg.convert('RGB')
def grid(items, tw, th, cols, path):
    rows = (len(items) + cols - 1) // cols
    sh = Image.new('RGB', (cols * tw, rows * (th + 18)), (24, 24, 30)); dr = ImageDraw.Draw(sh)
    for i, (label, im) in enumerate(items):
        x, y = (i % cols) * tw, (i // cols) * (th + 18)
        im = im.copy(); im.thumbnail((tw, th), Image.LANCZOS); sh.paste(im, (x + (tw - im.width) // 2, y + 18))
        dr.text((x + 3, y + 3), label, fill=(235, 235, 235))
    sh.save(path)
files = sorted(f for f in glob.glob(os.path.join(d, '*.png')) if '__' not in os.path.basename(f))
groups = {}
gaps = {}
for f in files:
    n = os.path.basename(f)[:-4]; g = n.split('_')[0]
    im, rgb = load(f); a = np.asarray(im)[..., 3]
    gaps[n] = im.height - 1 - np.where(a.max(1) > 0)[0].max()
    groups.setdefault(g, []).append((n, rgb, im))
for g, items in groups.items():
    w, h = items[0][1].size
    grid([(n, rgb) for n, rgb, _ in items], 240, int(240 * h / w), 8, os.path.join(d, f'__sheet_{g}.png'))
# zoom crops: head, hands/props, feet, left hair edge from the alpha bbox
pick = [n for n in gaps if n.startswith(('p00', 'p_ang', 'e_', 'ph_1', 'x_'))] + [n for n in gaps if n.startswith('g_') and n.endswith('1mid')]
crops = {'head': [], 'hands': [], 'feet': [], 'hairedge': []}
for n in pick:
    _, rgb, im = next(x for x in groups[n.split('_')[0]] if x[0] == n)
    l, t, r, b = np.asarray(im)[..., 3].nonzero()[1].min(), *[0] * 3
    ys, xs = np.asarray(im)[..., 3].nonzero(); l, r, t, b = xs.min(), xs.max(), ys.min(), ys.max(); H = b - t; W = r - l
    box = {'head': (l + W * .15, t, r - W * .15, t + H * head), 'hands': (l, t + H * hlo, r, t + H * hhi),
           'feet': (l + W * .15, b - H * .14, r - W * .15, b + 1), 'hairedge': (l, t + H * .15, l + W * .35, t + H * .7)}
    for k, bx in box.items():
        c = rgb.crop(tuple(int(v) for v in bx)); crops[k].append((n, c.resize((c.width * 2, c.height * 2), Image.LANCZOS)))
for k, items in crops.items():
    grid(items, 330 if k != 'hairedge' else 220, 330, 6, os.path.join(d, f'__zoom_{k}.png'))
print('frames', len(files), 'groups', {g: len(v) for g, v in groups.items()}, 'feet gap max', max(gaps.values()), [n for n, v in gaps.items() if v > 1])
