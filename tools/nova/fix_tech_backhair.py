"""Tech back hair (N7): recolor the pale blue-grey inpaint to the dark hair palette, keep strand shading, make it opaque.
usage: fix_tech_backhair.py <src.png> <dst.png> <preview.png>"""
import sys, numpy as np
from PIL import Image, ImageFilter
src, dst, prev = sys.argv[1:4]
a = np.array(Image.open(src).convert('RGBA')).astype(float)
rgb, al = a[:, :, :3], a[:, :, 3]
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]; lum = rgb.mean(-1)
strand = (al > 220) & (lum > 25) & (lum < 80) & (b < r + 25)
base = np.median(rgb[strand], axis=0); print('base', base, strand.sum())
pale = (al > 0) & (lum > 85) & (b > r + 4)
m = Image.fromarray((pale * 255).astype('uint8')).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
amt = np.array(m, float) / 255 * (al > 0)
# keep streak contrast: map pale luminance 85..230 to 0.7..1.45 of the hair base
k = np.clip(0.7 + (lum - 85) / 145 * 0.75, 0.6, 1.5)
fill = np.clip(base[None, None, :] * k[..., None], 0, 255)
rgb2 = rgb * (1 - amt[..., None]) + fill * amt[..., None]
# opaque inside the hair body: close alpha holes, then lift alpha where the inpaint was
solid = Image.fromarray(((al > 40) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(15))
solid = np.array(solid.filter(ImageFilter.GaussianBlur(2)), float) / 255
al2 = np.maximum(al, 255 * solid * (al > 0))
out = np.dstack([rgb2, al2]).clip(0, 255).astype('uint8')
Image.fromarray(out).save(dst)
bg = Image.new('RGBA', (out.shape[1], out.shape[0]), (255, 0, 255, 255)); bg.alpha_composite(Image.fromarray(out)); bg.save(prev)
print('pale', int(pale.sum()), 'alpha lifted', int((al2 > al + 1).sum()))
