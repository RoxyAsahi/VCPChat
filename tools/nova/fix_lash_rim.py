"""N8: remove the light dotted rim around an eyelash texture.
Semi-transparent edge pixels carry skin color from the cut-out; recolor them from the nearby opaque lash (dark) and drop
faint speckles, so the lash edge reads as a soft dark falloff instead of light dots.
usage: fix_lash_rim.py <lash.png> <out.png> [preview.png]"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_opening

src, dst = sys.argv[1:3]
im = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32)
rgb, a = im[..., :3], im[..., 3]
core = a > 200
fill = rgb.copy()
for s in (1.0, 2.0, 4.0):
    k = gaussian_filter(core.astype(np.float32), s)
    f = np.stack([gaussian_filter(rgb[..., i] * core, s) for i in range(3)], -1) / np.maximum(k, 1e-6)[..., None]
    todo = (~core) & (k > 0.03) & (fill == rgb).all(-1)
    fill = np.where(todo[..., None], f, fill)
lum, flum = rgb.mean(-1), fill.mean(-1)
# light edge pixels take the lash color; dark ones keep theirs
w = np.clip((lum - flum - 10) / 40, 0, 1) * (~core)
rgb2 = rgb * (1 - w[..., None]) + fill * w[..., None]
a2 = np.where(a < 40, 0, a)
keep = binary_opening(a2 > 0, iterations=1) | core
a2 = np.where(keep, a2, 0)
out = np.dstack([rgb2, a2]).clip(0, 255).astype('uint8')
Image.fromarray(out).save(dst)
print('recolored', int((w > 0.1).sum()), 'dropped', int(((a > 0) & (a2 == 0)).sum()))
if len(sys.argv) > 3:
    o = Image.fromarray(out); bg = Image.new('RGBA', o.size, (0, 160, 0, 255)); bg.alpha_composite(o)
    bg.resize((o.width * 8, o.height * 8), Image.NEAREST).save(sys.argv[3])
