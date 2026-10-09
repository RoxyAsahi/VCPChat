"""Build PSD2Live-ready PSDs from Codex's v2 art (fullbody/v2-src, a copy of the read-only wo/ output).

usage: python -I build_v2_psd.py <fullbody/v2-src> <fullbody/work-v2>

chibi: blank-face base + the 12 expression variants + the 8 action arm sets as extra layers.
       Layer names only seed the classifier; p2l_v2.py sets the final role/type/parameter from
       work-v2/chibi/layer_plan.json.
maid:  the fixed parts (no chin shadow on the neck), same naming as the v1 build.
"""
import glob, json, os, sys
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

sys.path.insert(0, os.path.dirname(__file__))
from build_fullbody_psd import ALPHA_FLOOR, MARGIN, BOTTOM, psd2live_name

# expression folder key -> eye shapes that are drawn closed (no blink rig, plain face detail)
CLOSED_EYES = {'happy': ('eye-r', 'eye-l'), 'wink': ('eye-r',)}
NO_LASH = {'stars'}                     # star outline has no lid rim to lift
ACTIONS = ['wave', 'salute', 'heart', 'tea', 'typing', 'shrug', 'akimbo', 'cheer']
DEFAULT_ARMS = ['handwear-r', 'hand-r', 'handwear-l', 'hand-l']

def load(path):
    a = np.asarray(Image.open(path).convert('RGBA')).copy()
    a[a[..., 3] < ALPHA_FLOOR] = 0
    return a

def lift_rim(a):
    """Move the dark top rim of an open eye into its own eyelash layer (blink closes into an arc)."""
    mask = a[..., 3] > 0
    ys, _ = np.where(mask)
    y0, h = ys.min(), ys.max() - ys.min() + 1
    lum = a[..., :3].astype(int) @ [299, 587, 114] // 1000
    rows = np.arange(a.shape[0])[:, None]
    rim = mask & (rows < y0 + 0.22 * h) & (lum < 120)
    lash = np.zeros_like(a)
    lash[rim] = a[rim]
    a[rim] = 0
    return lash

def chibi_layers(src):
    """(name, rgba, plan) bottom to top; plan = {role, side, type, parameter, switch_id}."""
    q = os.path.join(src, 'Q版修正版')
    out = []
    def add(name, a, role, side='none', type_='preset', param='', sid=0, group=''):
        if a[..., 3].any():
            out.append((name, a, dict(role=role, side=side, type=type_, parameter=param, switch_id=sid, group=group)))
    for f in sorted(glob.glob(os.path.join(q, '[0-9][0-9]_*.png'))):
        stem = os.path.splitext(os.path.basename(f))[0]
        name = psd2live_name('chibi', stem)
        side = 'right' if name.endswith('-r') else 'left' if name.endswith('-l') else 'none'
        if name in DEFAULT_ARMS:
            add(name, load(f), 'handwear', side, 'switch', 'ParamArmsDefault', 0, 'arms')
        else:
            out.append((name, load(f), None))
    neutral_dir = glob.glob(os.path.join(q, '表情', 'neutral-*'))[0]
    neutral = {os.path.splitext(os.path.basename(p))[0]: load(p) for p in glob.glob(os.path.join(neutral_dir, '*.png'))
               if os.path.basename(p)[0].isascii()}
    exps = []
    for d in sorted(glob.glob(os.path.join(q, '表情', '*'))):
        key = os.path.basename(d).split('-')[0]
        parts = {os.path.splitext(os.path.basename(p))[0]: load(p) for p in glob.glob(os.path.join(d, '*.png'))
                 if os.path.basename(p)[0].isascii()}
        if key != 'talk':
            exps.append(key)
        hide = key == 'neutral'
        param = 'ParamExpNeutralHide' if hide else f'ParamExp{key.capitalize()}'
        type_, sid = ('switch', 0) if hide else ('toggle', 0)
        for part in ('eye-r', 'eye-l', 'eyebrows', 'blush', 'effect', 'mouth'):
            if part not in parts:
                continue
            a = parts[part]
            if key == 'talk':
                if part != 'mouth':
                    # talk eyes are a redraw of the neutral eyes (bbox within 3 px): keep the neutral ones
                    bb = lambda x: np.array(Image.fromarray(x[..., 3]).getbbox())
                    assert np.abs(bb(a) - bb(neutral[part])).max() <= 3, f'talk {part} differs from neutral'
                    continue
                # the talk mouth is the lip-sync open mouth, faded in by ParamMouthOpenY
                add('mouth open', a, 'mouth', group='mouth')
                continue
            if part.startswith('eye-'):
                side = 'right' if part == 'eye-r' else 'left'
                if part in CLOSED_EYES.get(key, ()):
                    add(f'facedetail {key} {part}', a, 'facedetail', side, type_, param, sid, key)
                else:
                    lash = None if key in NO_LASH else lift_rim(a)
                    add(f'eyewhite-{part[-1]} {key}', a, 'eyewhite', side, type_, param, sid, key)
                    if lash is not None:
                        add(f'eyelash-{part[-1]} {key}', lash, 'eyelash', side, type_, param, sid, key)
            elif part == 'eyebrows':
                add(f'eyebrow {key}', a, 'eyebrow', 'none', type_, param, sid, key)
            elif part == 'mouth':
                if hide:   # neutral closed mouth: lip-sync fade + expression hide via authored opacity keys
                    add('mouth close', a, 'mouth_close', group='mouth')
                else:
                    add(f'facedetail {key} mouth', a, 'facedetail', 'none', type_, param, sid, key)
            else:
                add(f'blush {key} {part}', a, 'facedetail', 'none', type_, param, sid, key)
    for act in ACTIONS:
        d = glob.glob(os.path.join(src, '动作', act + '-*'))[0]
        for f in sorted(glob.glob(os.path.join(d, '*.png'))):
            stem = os.path.splitext(os.path.basename(f))[0]
            if stem not in ('arm-r', 'arm-l', 'arms-and-props'):
                continue
            side = {'arm-r': 'right', 'arm-l': 'left'}.get(stem, 'none')
            name = f'handwear{"-" + stem[-1] if side != "none" else ""} {act}'
            add(name, load(f), 'handwear', side, 'toggle', f'ParamAct{act.capitalize()}', 0, act)
    return out, exps

def maid_layers(src):
    d = os.path.join(src, '正常比例女仆修正版')
    out = []
    for f in sorted(glob.glob(os.path.join(d, '[0-9][0-9]_*.png'))):
        stem = os.path.splitext(os.path.basename(f))[0]
        name = psd2live_name('maid', stem)
        out.append((name, load(f), None))
        if name == 'mouth open':
            out.append(('mouth close', load(os.path.join(d, 'mouth-close-variant.png')), None))
    return out

def write_psd(layers, dst, variant):
    h, w = layers[0][1].shape[:2]
    union = np.zeros((h, w), bool)
    for _, a, _ in layers:
        union |= a[..., 3] > 0
    ys, xs = np.where(union)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cw, ch = x1 - x0, y1 - y0
    mx, mt, mb = round(cw * MARGIN), round(ch * MARGIN), round(ch * BOTTOM)
    W, H = int(cw + 2 * mx), int(ch + mt + mb)
    ox, oy = x0 - mx, y0 - mt
    psd = PSDImage.new('RGBA', (W, H), depth=8)
    plan = []
    for name, a, p in layers:
        canvas = np.zeros((H, W, 4), np.uint8)
        sx0, sy0, sx1, sy1 = max(0, ox), max(0, oy), min(w, ox + W), min(h, oy + H)
        canvas[sy0 - oy:sy1 - oy, sx0 - ox:sx1 - ox] = a[sy0:sy1, sx0:sx1]
        im = Image.fromarray(canvas, 'RGBA')
        bb = im.getchannel('A').getbbox()
        if not bb:
            continue
        psd.append(PixelLayer.frompil(im.crop(bb), psd, name, bb[1], bb[0]))
        plan.append({'layer': name, 'bbox': list(bb), **(p or {})})
    os.makedirs(dst, exist_ok=True)
    psd.save(os.path.join(dst, f'nova_{variant}.psd'))
    print(variant, W, H, len(plan), 'layers')
    return plan, [int(ox), int(oy), int(ox + W), int(oy + H)]

def main(src, work):
    chibi, exps = chibi_layers(src)
    plan, crop = write_psd(chibi, os.path.join(work, 'chibi'), 'chibi')
    with open(os.path.join(work, 'chibi', 'layer_plan.json'), 'w', encoding='utf-8') as fp:
        json.dump({'crop_from_source': crop, 'expressions': exps, 'actions': ACTIONS, 'layers': plan}, fp, ensure_ascii=False, indent=1)
    plan, crop = write_psd(maid_layers(src), os.path.join(work, 'maid'), 'maid')
    with open(os.path.join(work, 'maid', 'layer_plan.json'), 'w', encoding='utf-8') as fp:
        json.dump({'crop_from_source': crop, 'layers': plan}, fp, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
