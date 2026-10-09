"""Rebuild Codex's NovaTech.psd (512x768, 26 layers) at the parts' native 1024x1536 with the same layer names.

usage: python -I build_tech_hd.py <wo/outputs/NovaTech-Parts> <Codex NovaTech.psd> <out.psd>
Same merges as Codex (back hair + -r/-l, handwear + hand). RGB under transparent and faint pixels is bled
outward from the opaque interior so bilinear sampling of the atlas never pulls in stray colour at edges.
"""
import glob, os, sys
import numpy as np
from PIL import Image, ImageFilter
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

sys.path.insert(0, os.path.dirname(__file__))
from build_fullbody_psd import ALPHA_FLOOR

MERGE = {'back hair': ['back_hair', 'back_hair-r', 'back_hair-l'], 'handwear-r': ['handwear-r', 'hand-r'],
         'handwear-l': ['handwear-l', 'hand-l']}

def bleed(a, solid=200, steps=24):
    rgb = a[..., :3].astype(np.float32)
    known = a[..., 3] >= solid
    out = rgb.copy()
    for _ in range(steps):
        if known.all():
            break
        acc = np.zeros_like(out); n = np.zeros(known.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            k = np.roll(known, (dy, dx), (0, 1)); v = np.roll(out, (dy, dx), (0, 1))
            acc += v * k[..., None]; n += k
        grow = ~known & (n > 0)
        out[grow] = acc[grow] / n[grow][:, None]
        known = known | grow
    res = a.copy()
    # faint edge pixels keep their own hue only where they are fairly opaque; below that use the bled interior
    faint = a[..., 3] < solid
    res[faint, :3] = np.clip(out[faint], 0, 255).astype(np.uint8)
    return res

def main(parts, codex_psd, dst):
    files = {os.path.splitext(os.path.basename(f))[0][3:]: f for f in glob.glob(os.path.join(parts, '[0-9][0-9]_*.png'))}
    codex = PSDImage.open(codex_psd)
    W, H = codex.size[0] * 2, codex.size[1] * 2
    psd = PSDImage.new('RGBA', (W, H), depth=8)
    for l in codex.descendants():
        srcs = MERGE.get(l.name, [l.name.replace(' ', '_')])
        im = Image.new('RGBA', (W, H))
        for s in srcs:
            part = np.asarray(Image.open(files[s]).convert('RGBA')).copy()
            part[part[..., 3] < ALPHA_FLOOR] = 0   # same noise floor as the other builds
            im.alpha_composite(Image.fromarray(part, 'RGBA'))
        # Codex's layers are trimmed subsets of these parts (stray strands, faint fringe). Keep its trims: clip to its
        # alpha, doubled and grown by a couple of HD pixels so the clip never cuts into the sharper edge.
        cm = Image.new('L', codex.size); cm.paste(l.topil().getchannel('A'), (l.left, l.top))
        cm = cm.point(lambda v: 255 if v > 0 else 0).resize((W, H), Image.NEAREST).filter(ImageFilter.MaxFilter(5))
        cm = np.asarray(cm.filter(ImageFilter.GaussianBlur(1)), np.float32) / 255
        a = np.asarray(im).copy()
        a[..., 3] = (a[..., 3] * cm).astype(np.uint8)
        a = bleed(a)
        im = Image.fromarray(a, 'RGBA')
        bb = im.getchannel('A').getbbox()
        psd.append(PixelLayer.frompil(im.crop(bb), psd, l.name, bb[1], bb[0]))
    psd.save(dst)
    print('tech hd', W, H, len(list(psd.descendants())), 'layers ->', dst)

if __name__ == '__main__':
    main(*sys.argv[1:4])
