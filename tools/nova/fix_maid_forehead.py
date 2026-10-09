"""Maid N8: clean the forehead under the bangs.
face: repaint the forehead (above the eyes) as smooth skin so ghost strands, stair-stepped light rims and the dotted lash
ghost never show when the bangs or eyes move.  front hair: drop skin pixels baked into the bang tips and soften their
stair-stepped alpha edge.
usage: fix_maid_forehead.py <face.png> <face_out.png> <hair.png> <hair_out.png> <face_y_end> <preview_dir>"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, binary_dilation

face_src, face_dst, hair_src, hair_dst, y_end, prev = sys.argv[1:7]
y_end = int(y_end)


def load(p):
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


def preview(arr, path, k=3):
    im = Image.fromarray(arr.clip(0, 255).astype('uint8'))
    bg = Image.new('RGBA', im.size, (255, 0, 255, 255)); bg.alpha_composite(im)
    bg.resize((im.width * k, im.height * k), Image.NEAREST).save(path)


# face: normalized-convolution blur of opaque skin, blended in above y_end with a soft edge
f = load(face_src); rgb, a = f[..., :3], f[..., 3]
h, w = a.shape
yy = np.mgrid[0:h, 0:w][0]; xx = np.mgrid[0:h, 0:w][1]
band = (yy >= y_end - 8) & (yy < y_end + 16) & (xx > 25) & (xx < 125)
ok = ((a > 250) & ~band).astype(np.float32)
s = 7.0
k = gaussian_filter(ok, s)
smooth = np.stack([gaussian_filter(rgb[..., i] * ok, s) for i in range(3)], -1) / np.maximum(k, 1e-6)[..., None]
m = np.clip((y_end + 10 - yy) / 16.0, 0, 1)
m = np.maximum(m, gaussian_filter(band.astype(np.float32), 2.0) * 1.4).clip(0, 1)
m = m[..., None] * (k > 0.05)[..., None] * (a > 0)[..., None]
f[..., :3] = rgb * (1 - m) + smooth * m
Image.fromarray(f.clip(0, 255).astype('uint8')).save(face_dst)
preview(f, prev + '/m_face2.png')

# front hair: skin-colored pixels in the lower bangs become transparent; soften the alpha edge there
g = load(hair_src); rgb, a = g[..., :3], g[..., 3]
h, w = a.shape
yy = np.mgrid[0:h, 0:w][0]
r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
lum = rgb.mean(-1)
skin = (a > 0) & (yy > 95) & (r_ > 190) & (g_ > 150) & (r_ - b_ > 12) & (lum > 170)
skin = binary_dilation(skin, iterations=1) & (lum > 150) & (r_ > b_)
print('skin px', int(skin.sum()))
a2 = np.where(skin, 0, a)
low = (yy > 95).astype(np.float32)
a2 = a2 * (1 - low) + np.minimum(a2, gaussian_filter(a2, 0.8) * 1.15) * low
g[..., 3] = a2
Image.fromarray(g.clip(0, 255).astype('uint8')).save(hair_dst)
preview(g, prev + '/m_fronthair2.png')
