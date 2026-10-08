"""Copy a See-through PSD into a PSD2Live-friendly PSD.

See-through tags already match PSD2Live tags; this only splits paired parts
into -l / -r layers (character's left = screen right) and drops empty layers.

usage: python prep_psd2live.py in.psd out.psd
"""
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

PAIRED = {'eyewhite', 'irides', 'eyelash', 'eyebrow', 'ears'}


def split_lr(rgba: Image.Image, left: int):
    """Split a layer image at the gap between its two halves; returns (screen_left, screen_right)."""
    a = np.asarray(rgba)[..., 3]
    cols = np.where(a.max(axis=0) > 16)[0]
    if len(cols) == 0:
        return None
    # cut at the widest empty column run between the outermost columns, else at the middle
    occupied = a.max(axis=0) > 16
    best, run_start, best_cut = 0, None, (cols[0] + cols[-1]) // 2
    for x in range(cols[0], cols[-1] + 1):
        if not occupied[x]:
            run_start = x if run_start is None else run_start
            if x - run_start + 1 > best:
                best, best_cut = x - run_start + 1, (run_start + x) // 2
        else:
            run_start = None
    arr = np.asarray(rgba).copy()
    l_arr, r_arr = arr.copy(), arr.copy()
    l_arr[:, best_cut:, 3] = 0
    r_arr[:, :best_cut, 3] = 0
    return Image.fromarray(l_arr), Image.fromarray(r_arr), best


def add(out, im, name):
    bb = im.getchannel('A').getbbox()
    out.append(PixelLayer.frompil(im.crop(bb), out, name, bb[1], bb[0]))


def main(src, dst):
    psd = PSDImage.open(src)
    # RGBA document: an 'RGB' one makes frompil drop each layer's transparency channel
    out = PSDImage.new('RGBA', psd.size, depth=8)
    for layer in psd:  # bottom -> top order preserved
        img = layer.composite(viewport=(0, 0) + psd.size)
        if img is None or img.getchannel('A').getbbox() is None:
            print('skip empty', layer.name)
            continue
        img = img.convert('RGBA')
        if layer.name in PAIRED:
            res = split_lr(img, 0)
            if res:
                screen_l, screen_r, gap = res
                # character-right is screen-left
                for name, im in ((f'{layer.name}-r', screen_l), (f'{layer.name}-l', screen_r)):
                    if im.getchannel('A').getbbox():
                        add(out, im, name)
                        print('split', name, 'gap', gap)
                continue
        add(out, img, layer.name)
        print('keep', layer.name)
    out.save(dst)
    chk = PSDImage.open(dst)
    print('wrote', dst, [(l.name, l.bbox) for l in chk])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
