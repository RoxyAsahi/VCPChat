"""Build PSD2Live-ready RGBA PSDs from Codex's full-body Nova part PNGs (read-only input).

usage: python -I build_fullbody_psd.py <wo/outputs dir> <fullbody/work dir>

Every part PNG is full-canvas RGBA. We rename layers to PSD2Live aliases, insert the
closed-mouth variant directly above the open mouth, crop all layers uniformly to the
union content bbox (+2% margin, bottom margin <=1% so the soles sit at the canvas
bottom) and write an RGBA PSD whose layers keep per-pixel alpha.
"""
import glob, json, os, re, sys
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

ALPHA_FLOOR = 16          # drop faint matting noise far from the parts
MARGIN, BOTTOM = 0.02, 0.005

VARIANTS = {
    'tech':  'NovaTech-Parts',
    'maid':  'NovaMaid-Parts',
    'chibi': 'NovaChibi-Parts',
}

def psd2live_name(variant, stem):
    """Map Codex part file stems (01_back_hair-r) to PSD2Live layer names."""
    name = re.sub(r'^\d+_', '', stem).replace('_', ' ')
    fixed = {
        'mouth': 'mouth open',
        'apron': 'skirt apron',        # 'apron' alone is UNKNOWN; prefix 'skirt' -> BOTTOMWEAR skirt
        'bottomwear': 'skirt',
        'headwear bonnet': 'headwear bonnet',
    }
    name = fixed.get(name, name)
    if variant == 'chibi' and name in ('eye-r', 'eye-l'):
        # merged colour+outline eye: eyewhite gets the eye-closure squash so blink works
        name = 'eyewhite' + name[3:]
    return name

def chibi_eyes(imgs):
    """Chibi eyes are one merged shape and the face under them (and under the open
    mouth) still carries a faint outline / cyan remnant from the split. Paint the face
    flat skin there and
    lift the dark top rim of each eye into an 'eyelash' layer, so on blink PSD2Live
    squashes the eye away and lowers the rim into a closed-eye arc."""
    from scipy import ndimage
    by = {name: i for i, (_, name, _) in enumerate(imgs)}
    face = imgs[by['face']][2]
    out = []
    for stem, name, a in imgs:
        out.append((stem, name, a))
        if not name.startswith('eyewhite') and name != 'mouth open':
            continue
        mask = a[..., 3] > 0
        grown = ndimage.binary_dilation(mask, iterations=6)
        ring = ndimage.binary_dilation(grown, iterations=6) & ~grown & (face[..., 3] > 200)
        rgb = face[..., :3].astype(int)
        lum = rgb @ [299, 587, 114] // 1000
        skin = np.median(face[ring & (lum > 180)][:, :3], axis=0).astype(np.uint8)
        # keep dark brown strokes (hair shadow / face lines); repaint cyan remnants and faint outlines
        keep = (lum < 90) & (rgb[..., 0] >= rgb[..., 2])
        fill = grown & (face[..., 3] > 0) & ~keep
        face[fill, :3] = skin
        if name == 'mouth open':   # the open mouth fades out when closing: keep the skin under it clean
            continue
        ys, xs = np.where(mask)
        y0, h = ys.min(), ys.max() - ys.min() + 1
        elum = a[..., :3].astype(int) @ [299, 587, 114] // 1000
        rows = np.arange(a.shape[0])[:, None]
        rim = mask & (rows < y0 + 0.22 * h) & (elum < 120)
        lash = np.zeros_like(a)
        lash[rim] = a[rim]
        a[rim] = 0
        out.append((stem + '+rim', 'eyelash' + name[len('eyewhite'):], lash))
    return out

def main(src_root, work_root):
    report = {}
    for variant, folder in VARIANTS.items():
        src = os.path.join(src_root, folder)
        files = sorted(glob.glob(os.path.join(src, '[0-9][0-9]_*.png')))
        layers = []
        for f in files:
            stem = os.path.splitext(os.path.basename(f))[0]
            layers.append((stem, psd2live_name(variant, stem), f))
            if psd2live_name(variant, stem) == 'mouth open':
                layers.append(('mouth-close-variant', 'mouth close',
                               os.path.join(src, 'mouth-close-variant.png')))
        imgs = []
        for stem, name, f in layers:
            a = np.asarray(Image.open(f).convert('RGBA')).copy()
            a[a[..., 3] < ALPHA_FLOOR] = 0
            imgs.append((stem, name, a))
        if variant == 'chibi':
            imgs = chibi_eyes(imgs)
        h, w = imgs[0][2].shape[:2]
        union = np.zeros((h, w), bool)
        for _, _, a in imgs:
            union |= a[..., 3] > 0
        ys, xs = np.where(union)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        cw, ch = x1 - x0, y1 - y0
        mx, mt, mb = round(cw * MARGIN), round(ch * MARGIN), round(ch * BOTTOM)
        W, H = cw + 2 * mx, ch + mt + mb
        ox, oy = x0 - mx, y0 - mt  # canvas origin in source coords (may be <0)
        out = PSDImage.new('RGBA', (int(W), int(H)), depth=8)
        mapping = []
        for stem, name, a in imgs:
            canvas = np.zeros((H, W, 4), np.uint8)
            sx0, sy0 = max(0, ox), max(0, oy)
            sx1, sy1 = min(w, ox + W), min(h, oy + H)
            canvas[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = a[sy0:sy1, sx0:sx1]
            im = Image.fromarray(canvas, 'RGBA')
            bb = im.getchannel('A').getbbox()
            if not bb:
                continue
            out.append(PixelLayer.frompil(im.crop(bb), out, name, bb[1], bb[0]))
            mapping.append({'source': stem, 'layer': name, 'bbox': list(bb)})
        dst = os.path.join(work_root, variant)
        os.makedirs(dst, exist_ok=True)
        psd_path = os.path.join(dst, f'nova_{variant}.psd')
        out.save(psd_path)
        out.composite().save(os.path.join(dst, f'nova_{variant}_composite.png'))
        report[variant] = {'psd': psd_path, 'canvas': [int(W), int(H)],
                           'crop_from_source': [int(ox), int(oy), int(ox + W), int(oy + H)],
                           'margins_px': {'side': int(mx), 'top': int(mt), 'bottom': int(mb)},
                           'layers_bottom_to_top': mapping}
        print(variant, W, H, 'margins', mx, mt, mb, len(mapping), 'layers')
    with open(os.path.join(work_root, 'layer_mapping.json'), 'w', encoding='utf-8') as fp:
        json.dump(report, fp, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
