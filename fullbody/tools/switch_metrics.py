import json, sys, glob, os
import numpy as np
from PIL import Image
d = sys.argv[1]
rep = json.load(open(os.path.join(d, 'switch_report.json'), encoding='utf-8'))
out = []
for i, st in enumerate(rep['steps']):
    tag = f"{i+1:02d}_{st['outfitId']}"
    a = np.asarray(Image.open(os.path.join(d, tag + '_canvas.png')).convert('RGBA'))[..., 3]
    H, W = a.shape
    rows = np.where((a >= 128).any(1))[0]; cols = np.where((a >= 128).any(0))[0]
    dpr = st['model']['dpr']
    def diff(n):
        b = np.asarray(Image.open(os.path.join(d, f'{tag}_{n}.png')).convert('RGBA')).astype(int)
        c = np.asarray(Image.open(os.path.join(d, tag + '_canvas.png')).convert('RGBA')).astype(int)
        return int((np.abs(b - c).sum(2) > 40).sum())
    r = {'step': tag, 'before': st['outfitBefore'], 'canvas': [W, H], 'win': st['win']['bounds'], 'content': st['win']['content'],
         'feet_gap_css': round((H - 1 - rows.max()) / dpr, 2), 'top_gap_css': round(rows.min() / dpr, 1),
         'left_css': round(cols.min() / dpr, 1), 'right_css': round((W - 1 - cols.max()) / dpr, 1),
         'figure_css': [round((cols.max() - cols.min() + 1) / dpr), round((rows.max() - rows.min() + 1) / dpr)],
         'eyes0_mouth1_diff_px': diff('eyes0_mouth1'), 'gaze_left_diff_px': diff('gaze_left'),
         'console': [l for l in st['console'] if not l.startswith('log:') or 'rror' in l], 'state': st['state']}
    out.append(r); print(json.dumps(r, ensure_ascii=False))
json.dump(out, open(os.path.join(d, 'switch_metrics.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
