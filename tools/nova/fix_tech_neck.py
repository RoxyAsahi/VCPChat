"""Tech neck (D7): erase the chin outline painted on the neck so it doesn't show as a dark crease when the head turns.
usage: fix_tech_neck.py <neck.png> <out.png> <preview.png>"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_dilation
src, dst, prev = sys.argv[1:4]
im = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32)
rgb, a = im[..., :3], im[..., 3]
r, g = rgb[..., 0], rgb[..., 1]
yy = np.mgrid[0:a.shape[0], 0:a.shape[1]][0]
line = (r - g > 55) & (yy > 45) & (yy < 80) & (a > 0)
m = binary_dilation(line, iterations=1)
print('line px', int(line.sum()), 'mask', int(m.sum()))
ok = (~m) & (a > 200)
fill = np.zeros_like(rgb)
for s in (1.0, 2.0, 4.0):
    k = gaussian_filter(ok.astype(np.float32), s)
    f = np.stack([gaussian_filter(rgb[..., i] * ok, s) for i in range(3)], -1) / np.maximum(k, 1e-6)[..., None]
    fill = np.where((k > 0.05)[..., None] & (fill.sum(-1) == 0)[..., None], f, fill)
res = np.where(m[..., None], fill, rgb)
out = np.dstack([res, a]).clip(0, 255).astype('uint8')
Image.fromarray(out).save(dst)
bg = Image.new('RGBA', (out.shape[1], out.shape[0]), (255, 0, 255, 255)); bg.alpha_composite(Image.fromarray(out))
bg.resize((out.shape[1] * 6, out.shape[0] * 6), Image.NEAREST).save(prev)
