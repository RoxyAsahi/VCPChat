"""N8: drop skin pixels baked into the bang tips of a front-hair texture and soften their stair-stepped alpha edge,
so no light polygon shows when the bangs move over the face.  Only the window x0..x1, y0..y1 is touched (keeps ears).
usage: fix_bang_skin.py <hair.png> <out.png> <x0> <y0> <x1> <y1> [preview.png]"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_dilation

src, dst = sys.argv[1:3]
x0, y0, x1, y1 = map(int, sys.argv[3:7])
g = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32)
rgb, a = g[..., :3], g[..., 3]
h, w = a.shape
yy, xx = np.mgrid[0:h, 0:w]
win = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
lum = rgb.mean(-1)
skin = win & (a > 0) & (r_ > 185) & (g_ > 140) & (r_ - b_ > 12) & (lum > 165)
skin = binary_dilation(skin, iterations=1) & win & (lum > 145) & (r_ > b_)
print('skin px', int(skin.sum()))
a2 = np.where(skin, 0, a)
soft = gaussian_filter(win.astype(np.float32), 2.0)
a2 = a2 * (1 - soft) + np.minimum(a2, gaussian_filter(a2, 0.8) * 1.15) * soft
g[..., 3] = a2
out = g.clip(0, 255).astype('uint8')
Image.fromarray(out).save(dst)
if len(sys.argv) > 7:
    o = Image.fromarray(out); bg = Image.new('RGBA', o.size, (0, 160, 0, 255)); bg.alpha_composite(o)
    bg.resize((o.width * 3, o.height * 3), Image.NEAREST).save(sys.argv[7])
