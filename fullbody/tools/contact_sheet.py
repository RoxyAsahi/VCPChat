"""Build a labelled contact sheet + metrics from deskpet_capture.mjs output.

usage: python -I contact_sheet.py <raw capture dir> <out png> <title>

Feet gap = window bottom minus the lowest row with alpha >= 128, in canvas (device) px and
CSS px (device px / devicePixelRatio from meta.json). Mouth close-up = crop around the
region where mouth_0 and mouth_1 differ, enlarged 3x.
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ORDER = ['idle_0', 'gaze_left', 'gaze_right', 'gaze_top', 'eyes_closed',
         'nod_250', 'nod_500', 'nod_750', 'shake_250', 'shake_500', 'shake_750',
         'turn_000', 'turn_120', 'turn_240', 'turn_400', 'turn_600', 'turn_900']
BG = (236, 238, 242)

def font(size):
    for f in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\arial.ttf'):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

def on_bg(im):
    bg = Image.new('RGBA', im.size, BG + (255,))
    return Image.alpha_composite(bg, im).convert('RGB')

def main(raw, out, title):
    meta = json.load(open(os.path.join(raw, 'meta.json'), encoding='utf-8'))
    dpr = meta['setup']['dpr']
    imgs = {n: Image.open(os.path.join(raw, n + '.png')).convert('RGBA') for n in ORDER + ['mouth_0', 'mouth_1']}
    a = np.asarray(imgs['idle_0'])[..., 3]
    rows = np.where((a >= 128).any(axis=1))[0]
    H = a.shape[0]
    gap_dev = H - 1 - rows.max()
    cols = np.where((a >= 128).any(axis=0))[0]
    metrics = {'canvas_px': list(a.shape[::-1]), 'dpr': dpr, 'feet_gap_device_px': int(gap_dev),
               'feet_gap_css_px': round(gap_dev / dpr, 2),
               'char_bbox_device': [int(cols.min()), int(rows.min()), int(cols.max()), int(rows.max())]}
    # mouth close-up
    m0, m1 = np.asarray(imgs['mouth_0']).astype(int), np.asarray(imgs['mouth_1']).astype(int)
    diff = np.abs(m0 - m1).sum(axis=2) > 40
    ys, xs = np.where(diff)
    mr = meta['setup'].get('mouth')
    metrics['mouth_drawables'] = mr and mr['ids']
    if mr:
        cx, cy = int((mr['x0'] + mr['x1']) / 2 * dpr), int((mr['y0'] + mr['y1']) / 2 * dpr)
        metrics['mouth_center_device'] = [cx, cy]
        metrics['mouth_diff_px'] = int(diff[cy - 18:cy + 18, cx - 27:cx + 27].sum())
    elif len(ys):
        cy, cx = int(np.median(ys)), int(np.median(xs))
        metrics['mouth_diff_px'] = int(diff.sum())
        metrics['mouth_center_device'] = [cx, cy]
    else:
        cy, cx = rows.min() + 60, (cols.min() + cols.max()) // 2
        metrics['mouth_diff_px'] = 0
    box = (cx - 55, cy - 60, cx + 55, cy + 30)   # lower face; mouth mesh bbox sits below the lips
    close = [on_bg(imgs[k].crop(box)).resize((330, 270), Image.LANCZOS) for k in ('mouth_0', 'mouth_1')]
    tiles = [(n, on_bg(imgs[n])) for n in ORDER]
    tw, th = tiles[0][1].size
    tw2, th2 = tw // 2, th // 2
    per_row = 9
    lab = 26
    nrows = (len(tiles) + per_row - 1) // per_row
    sheet_w = per_row * tw2
    header = 60
    mouth_h = 270 + lab
    sheet = Image.new('RGB', (sheet_w, header + nrows * (th2 + lab) + mouth_h + 10), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    d.text((10, 8), title, fill=(20, 20, 20), font=font(24))
    d.text((10, 36), f"feet gap {metrics['feet_gap_css_px']} css px ({metrics['feet_gap_device_px']} device px @dpr {dpr}); "
                     f"canvas {metrics['canvas_px']}", fill=(80, 80, 80), font=font(15))
    for i, (n, t) in enumerate(tiles):
        x, y = (i % per_row) * tw2, header + (i // per_row) * (th2 + lab)
        sheet.paste(t.resize((tw2, th2), Image.LANCZOS), (x, y + lab))
        d.text((x + 4, y + 3), n, fill=(30, 30, 30), font=font(15))
    y = header + nrows * (th2 + lab)
    for i, (k, c) in enumerate(zip(('ParamMouthOpenY = 0', 'ParamMouthOpenY = 1'), close)):
        sheet.paste(c, (10 + i * 350, y + lab))
        d.text((10 + i * 350, y + 3), k, fill=(30, 30, 30), font=font(15))
    sheet.save(out)
    json.dump(metrics, open(os.path.splitext(out)[0] + '_metrics.json', 'w'), indent=1)
    print(json.dumps(metrics))

if __name__ == '__main__':
    main(*sys.argv[1:4])
