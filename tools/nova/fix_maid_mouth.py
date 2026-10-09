"""D5 (maid): clean the mouth and nose textures (3x parts from upscale_parts).
- closed mouth: the cut-out is mostly white fragments around a broken red line; redraw it as one tapered line along the
  same path (column centroid of the dark/red pixels, smoothed by a quadratic fit).
- open mouth: the skin margin around the lips ends in a hard pale rim (reads as a frame); fade the skin out softly.
- nose: soften its hard alpha edge (dotted light rim).
usage: fix_maid_mouth.py <close.png> <open.png> <nose.png> <outdir> <k> [preview.png]"""
import sys, os, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, distance_transform_edt, binary_closing, binary_fill_holes

cl, op, no, outdir, k = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
load = lambda p: np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)
outs = []


def save(arr, name):
    p = os.path.join(outdir, name); Image.fromarray(arr.clip(0, 255).astype('uint8')).save(p); outs.append(p); print(p)


# closed mouth
m = load(cl); rgb, a = m[..., :3], m[..., 3] / 255
lum = rgb.mean(-1)
ink = a * np.clip((215 - lum) / 80, 0, 1) * np.clip((rgb[..., 0] - rgb[..., 2]) / 30, 0, 1)
h, w = a.shape
ys = np.arange(h)[:, None]
col = ink.sum(0)
xs = np.nonzero(col > 0.6)[0]
cy = (ink * ys).sum(0)[xs] / col[xs]
fit = np.polyfit(xs, cy, 2, w=col[xs])
x0, x1 = xs.min(), xs.max()
ink_col = np.median(rgb[ink > 0.5], 0) if (ink > 0.5).any() else np.array([180, 90, 90.])
ink_col = ink_col * 0.85 + np.array([190, 120, 115.]) * 0.15
print('closed line x', x0, x1, 'fit', fit.round(4), 'color', ink_col.round())
Y, X = np.mgrid[0:h, 0:w].astype(np.float32)
yc = np.polyval(fit, np.clip(X, x0, x1))
t = np.clip((X - x0) / max(x1 - x0, 1), 0, 1)
width = (0.55 + 0.45 * np.sin(np.pi * t) ** 0.6) * 0.75 * k  # half thickness, tapered ends
d = np.abs(Y - yc)
along = np.clip(np.minimum(X - x0 + 0.5 * k, x1 - X + 0.5 * k) / (0.5 * k), 0, 1)
al = np.clip(width - d + 0.5, 0, 1) * along
new = np.dstack([np.broadcast_to(ink_col, (h, w, 3)), al * 215])
save(new, 'mouth_close_d6.png')

# open mouth: fade skin margin
m = load(op); rgb, a = m[..., :3], m[..., 3]
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
skin = (r > 225) & (r - b > 14) & (rgb.mean(-1) > 205)
core = (a > 128) & (rgb.mean(-1) < 200) & ~skin  # lips and mouth cavity (teeth are enclosed by them)
inner = binary_fill_holes(binary_closing(core, iterations=3 * k))
dist = distance_transform_edt(~inner)
fade = np.clip(1 - (dist - 2.5 * k) / (3.5 * k), 0, 1)
fade = gaussian_filter(fade, 0.6 * k)
a2 = a * np.where(inner, 1, fade)
save(np.dstack([rgb, a2]), 'mouth_open_d6.png')

# nose: soft alpha edge
m = load(no); rgb, a = m[..., :3], m[..., 3]
inside = distance_transform_edt(a > 128)
a2 = a * np.clip(inside / (2.2 * k), 0, 1)
a2 = gaussian_filter(a2, 0.5 * k)
save(np.dstack([rgb, np.minimum(a2, a)]), 'nose_d6.png')

if len(sys.argv) > 6:
    ims = [Image.open(p) for p in outs]
    W = sum(i.width * 3 + 10 for i in ims); H = max(i.height * 3 for i in ims)
    sheet = Image.new('RGBA', (W, H), (246, 222, 212, 255)); x = 0
    for i in ims:
        sheet.alpha_composite(i.resize((i.width * 3, i.height * 3), Image.NEAREST), (x, 0)); x += i.width * 3 + 10
    sheet.save(sys.argv[6])
