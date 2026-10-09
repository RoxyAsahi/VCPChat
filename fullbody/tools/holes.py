import sys, os, numpy as np
from PIL import Image
from scipy import ndimage
for d in sys.argv[1:]:
    tot = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith('.png') or f.startswith('__'): continue
        a = np.array(Image.open(f'{d}/{f}'))[..., 3]
        solid = ndimage.binary_fill_holes(a > 200)          # silhouette with holes filled
        hole = solid & (a < 230)
        tot[f[:-4]] = int(hole.sum())
    print(d, tot)
