"""D6: redraw the jaw outline of a face texture as one smooth anti-aliased line.
The cut-out jaw is a 1 px stair-stepped line whose pixels alternate dark/light, so it reads as a dotted chin outline.
The face is upsampled k x, its alpha contour smoothed (signed distance), and below y_from (source px) the outermost
band is painted with a single line color; interior skin is kept.
usage: fix_chin_line.py <face.png> <out.png> <k> <y_from> [preview.png|-] [line r,g,b] [smooth=0.9]"""
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, distance_transform_edt

src, dst, k, y_from = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
im = np.asarray(Image.open(src).convert('RGBA')).astype(np.float32)
h, w = im.shape[:2]
rgb, a = im[..., :3], im[..., 3]
yy = np.mgrid[0:h, 0:w][0]
# line color from the dark rim pixels of the jaw
edge = (a > 0) & (gaussian_filter((a > 0).astype(np.float32), 1.0) < 0.75) & (yy >= y_from)
lum = rgb.mean(-1)
dark = edge & (lum < np.percentile(lum[edge], 40))
line = np.median(rgb[dark], 0)
if len(sys.argv) > 6: line = np.array([float(v) for v in sys.argv[6].split(',')])
sm = float(sys.argv[7]) if len(sys.argv) > 7 else 0.9
print('line color', line.round(), 'from', int(dark.sum()), 'px')

# premultiplied k x upsample
pm = np.dstack([rgb * a[..., None] / 255, a])
up = np.dstack([np.asarray(Image.fromarray(pm[..., i].clip(0, 255).astype('uint8')).resize((w * k, h * k), Image.LANCZOS))
                .astype(np.float32) for i in range(4)])
A = up[..., 3]
RGB = np.where(A[..., None] > 1, up[..., :3] / np.maximum(A[..., None], 1) * 255, 0)
H, W = A.shape
Y = np.mgrid[0:H, 0:W][0]
# smooth contour -> signed distance (positive inside), in k x pixels
m = gaussian_filter(A, sm * k) > 127
sd = distance_transform_edt(m) - distance_transform_edt(~m)
skin_core = sd > 2.6 * k
fill = RGB.copy(); done = skin_core.copy()
for s in (1.0, 2.0, 4.0, 8.0):
    s *= k
    wgt = gaussian_filter(skin_core.astype(np.float32), s)
    f = np.stack([gaussian_filter(RGB[..., i] * skin_core, s) for i in range(3)], -1) / np.maximum(wgt, 1e-6)[..., None]
    todo = (~done) & (wgt > 0.005); fill[todo] = f[todo]; done |= todo
# region weight: only the jaw (feathered start at y_from)
reg = np.clip((Y - y_from * k) / (6 * k), 0, 1)
lw = 0.95 * k  # line width
la = np.clip(lw + 0.5 - sd, 0, 1) * np.clip(sd + 0.5, 0, 1) + np.clip(0.5 - sd, 0, 1)  # line covers band 0..lw
la = np.clip(la, 0, 1)
new_rgb = np.where(sd[..., None] > lw + 0.5, RGB, fill * (1 - la[..., None]) + line * la[..., None])
new_rgb = np.where(sd[..., None] > lw + 0.5, RGB, new_rgb)
new_a = np.clip(sd + 0.5, 0, 1) * 255
out_rgb = RGB * (1 - reg[..., None]) + new_rgb * reg[..., None]
# outside the jaw keep the upsampled alpha; bleed color under transparent pixels everywhere
out_a = A * (1 - reg) + new_a * reg
out_rgb = np.where(out_a[..., None] < 8, fill, out_rgb)
o = np.dstack([out_rgb, out_a]).clip(0, 255).astype('uint8')
Image.fromarray(o).save(dst)
if len(sys.argv) > 5 and sys.argv[5] != '-':
    oi = Image.fromarray(o); bg = Image.new('RGBA', oi.size, (0, 160, 0, 255)); bg.alpha_composite(oi)
    bg.crop((0, int(H * 0.65), W, H)).resize((W * 2, int(H * 0.35) * 2), Image.NEAREST).save(sys.argv[5])
