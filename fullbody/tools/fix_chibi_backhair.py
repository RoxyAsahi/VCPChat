"""Clean the chibi ArtMeshBackHair atlas region after export.

The lower part of the back-hair layer is a hard-edged rectangle (atlas x 174..549, y 222..~905) carrying
inpaint residue (collar wedges, a wavy patch) on its sides. At rest it is covered by the side hair, but
with head tilt (ParamAngleZ ~ +-12 already in idle) the side hair swings off it and the residue shows.
This fills the residue with the flat hair colour, the straight sides included, so they read as hair when exposed.
It also thickens the neutral eyelashes and the closed mouth by 2 px: the closed eye is the lash bent into a lid curve and read too thin,
and erases two brow-tip specks the segmentation left on the bottom edge of the headwear layer (drawn above the bangs).
Usage: fix_chibi_backhair.py <texture_00.png>   (in place; refuses a texture whose layout differs)
"""
import sys
import cv2
import numpy as np
from PIL import Image

X0, X1 = 174, 549


def main(path):
    a = np.array(Image.open(path).convert('RGBA'))
    # layout guard: the rectangle edges must be where this export put them
    assert a[300, X0, 3] > 200 and a[300, X0 - 1, 3] == 0 and a[300, X1, 3] > 200 and a[300, X1 + 1, 3] == 0, 'atlas layout changed'
    # the hair here is flat cel colour: fill the residue with it, then put the two strand lines back
    base = np.median(a[620:700, 300:420, :3].reshape(-1, 3), axis=0).astype(np.uint8)
    strands = [(274, 297), (428, 455)]
    keep = {x: a[608:670, x0:x1].copy() for x, (x0, x1) in enumerate(strands)}
    a[545:608, 185:541, :3] = base         # collar wedges across the strands
    a[545:702, 185:202, :3] = base         # sliver right of the left strand line
    a[598:768, 494:549, :3] = base         # wavy patch on the right
    a[532:545, 500:541, :3] = base         # tip of the right collar wedge
    a[480:695, 174:188, :3] = base         # wavy side-hair outline residue on the left edge (pale ghost once faded)
    a[480:700, 536:550, :3] = base         # same on the right edge
    w = a[680:760, 188:262, :3]            # cream tip highlight cut off flat at its top: keep only its lower part
    w[w.astype(int).sum(-1) > 600] = base
    a[80:236, 300:420, :3] = base          # smudge above the crown line
    a[252:330, 300:420, :3] = base         # ... and below it
    sm = a[60:360, 280:440, 3]             # the smudge is also a few semi-transparent pinholes
    sm[sm > 200] = 255
    for x, (x0, x1) in enumerate(strands):
        a[546:608, x0:x1] = keep[x][:62]
    # the straight sides are plain hair colour now (filled above), so they read as hair once exposed.  They stay fully
    # opaque: the side hair meets them edge to edge, and any fade (it was 34 px) showed the background as a see-through
    # band between the body and the side hair (#63 N3)
    # neutral eyelash L / R and the closed mouth (a thin line that breaks into dashes at pet size):
    # grow the stroke 2 px, filled with the stroke colour
    for x0, y0, x1, y1 in ((1164, 1618, 1239, 1652), (1163, 1654, 1238, 1688), (1076, 1864, 1176, 1892)):
        r = a[y0:y1 + 1, x0:x1 + 1]
        al = r[..., 3].copy()
        assert (al > 220).sum() > 300, 'eyelash / mouth atlas box moved'
        col = np.median(r[al > 220][:, :3], axis=0).astype(np.uint8)
        rgb = r[..., :3].astype(int)       # the lash's inner rim carries anti-aliased iris cyan: shows on a closed lid
        r[..., :3][(rgb[..., 1] > rgb[..., 0] + 30) & (rgb[..., 2] > rgb[..., 0] + 30)] = col
        d = cv2.dilate(al, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        r[..., :3] = np.where((d > al)[..., None], col, r[..., :3])
        r[..., 3] = d
    # sleepy lash L5 / R4 (the sleep state's closed lid): same cyan rim, no thickening
    for x0, y0, x1, y1 in ((1268, 1871, 1373, 1894), (462, 1868, 567, 1891)):
        r = a[y0:y1 + 1, x0:x1 + 1]
        al = r[..., 3]
        col = np.median(r[al > 220][:, :3], axis=0).astype(np.uint8)
        rgb = r[..., :3].astype(int)
        r[..., :3][(rgb[..., 1] > rgb[..., 0] + 30) & (rgb[..., 2] > rgb[..., 0] + 30)] = col
    # headwear atlas box: the only islands touching its bottom edge that are not the two hair clips are brow tips
    hx0, hy0, hx1, hy1 = 1219, 989, 1931, 1301
    hw = a[hy0:hy1 + 1, hx0:hx1 + 1]
    n, lab, st, _ = cv2.connectedComponentsWithStats((hw[..., 3] > 10).astype(np.uint8), 8)
    specks = [k for k in range(1, n) if st[k, 4] < 800 and st[k, 1] + st[k, 3] >= hw.shape[0] - 2]
    assert len(specks) <= 2, 'headwear atlas box moved'
    for k in specks:
        hw[..., 3][cv2.dilate((lab == k).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0] = 0
    Image.fromarray(a).save(path)
    print('fixed', path)


if __name__ == '__main__':
    main(sys.argv[1])
