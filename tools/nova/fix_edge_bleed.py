"""N8: anti-alias a hard (0/255) alpha edge and bleed the opaque color into transparent pixels.
Hair layers were cut with binary alpha and keep skin RGB under the transparent pixels; texture filtering then pulls
that skin color into the edge (light dotted rims) and the hard cut reads as stair steps.
usage: fix_edge_bleed.py <in.png> <out.png> [alpha_sigma=0.7]"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

src, dst = sys.argv[1:3]
sig = float(sys.argv[3]) if len(sys.argv) > 3 else 0.7
im = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32)
rgb, a = im[..., :3], im[..., 3]
solid = a > 128
out = rgb.copy()
done = solid.copy()
for s in (0.8, 1.5, 3.0, 6.0):
    k = gaussian_filter(solid.astype(np.float32), s)
    f = np.stack([gaussian_filter(rgb[..., i] * solid, s) for i in range(3)], -1) / np.maximum(k, 1e-6)[..., None]
    todo = (~done) & (k > 0.01)
    out[todo] = f[todo]; done |= todo
# soft edge: blur only shrinks alpha inside (no halo growth beyond one pixel)
ab = gaussian_filter(a, sig)
edge = gaussian_filter(solid.astype(np.float32), 1.0)
edge = (edge > 0.02) & (edge < 0.98)
a2 = np.where(edge, ab, a)
o = np.dstack([out, a2]).clip(0, 255).astype('uint8')
Image.fromarray(o).save(dst)
print('bled', int((~solid & done).sum()), 'edge', int(edge.sum()))
