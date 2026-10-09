"""Clean native sclera surfaces and limit endpoint gaze travel in PSD2Live.

Run on the saved tech/maid hair-repair project before gaze edits. Extract the
original eyewhite layers with extract_eye_surfaces.py; do not use cleaned inputs.
"""
import itertools
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

if len(sys.argv) != 5:
    raise SystemExit("Usage: python -I fix_eye_surfaces.py <helper tools directory> <original eye PNG directory> <tech|maid> <output directory>")
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from p2l_mcp import Client
from p2l_v2 import run

source = Path(sys.argv[2]).resolve()
outfit = sys.argv[3]
output = Path(sys.argv[4]).resolve()
output.mkdir(parents=True, exist_ok=True)
assert outfit in ('tech', 'maid'), outfit
c = Client()
project = c.call('workspace_inspect', {'scope': 'project'})['data']
pid, state = project['project_id'], project['state']
assert project['canvas'] == ([1024, 1536] if outfit == 'tech' else [766, 1551]), project['canvas']
for side in ('L', 'R'):
    obj = c.call('workspace_inspect', {'scope': 'objects', 'target': f'warp:DeformEyeGaze{side}'})['data']
    assert obj['axes'] == {'ParamEyeBallX': [-1.0, 0.0, 1.0], 'ParamEyeBallY': [-1.0, 0.0, 1.0]}, obj['axes']
layers = c.call('workspace_inspect', {'scope': 'layers', 'limit': 64})['data']['items']
ids = {layer['name']: layer['id'] for layer in layers}
reports = []
for side in ('l', 'r'):
    name = f'eyewhite-{side}'
    a = np.array(Image.open(source / f'{outfit}-{name}.png').convert('RGBA'))
    rgb = a[:, :, :3].astype(float)
    lum = rgb.mean(-1)
    chroma = rgb.max(-1) - rgb.min(-1)
    candidate = ((lum > 135) & (chroma < 32) & (a[:, :, 3] > 128)).astype('uint8') * 255
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    assert contours, name
    mask = np.zeros_like(candidate)
    cv2.drawContours(mask, [max(contours, key=cv2.contourArea)], -1, 255, -1)
    soft = np.array(Image.fromarray(mask).filter(ImageFilter.GaussianBlur(.45)))
    original_alpha = a[:, :, 3].copy()
    a[:, :, 3] = np.minimum(original_alpha, soft)
    row = []
    for y in range(a.shape[0]):
        valid = (candidate[y] > 0) & (original_alpha[y] > 128)
        row.append(float(np.median(lum[y, valid])) if valid.any() else 225.)
    smooth = cv2.GaussianBlur(np.asarray(row, dtype='float32')[:, None], (1, 3), 0)[:, 0]
    a[:, :, :3] = np.clip(smooth, 150, 250).astype('uint8')[:, None, None]
    retained = float(a[:, :, 3].sum() / original_alpha.sum())
    assert .5 < retained < 1., (outfit, name, retained)
    destination = output / f'{outfit}-{name}-clean.png'
    Image.fromarray(a).save(destination)
    state = run(c, 'layer_replace_image', {'layer_id': ids[name], 'path': str(destination), 'rebuild_mesh': False}, pid, state)['state']
    reports.append({'layer': name, 'retained_alpha_fraction': retained, 'canvas_size_unchanged': True})
changes = []
for side in ('L', 'R'):
    for x, y in itertools.product((-1., 0., 1.), repeat=2):
        if x or y:
            changes.append({'op': 'seed', 'target': f'warp:DeformEyeGaze{side}', 'key': {'ParamEyeBallX': x * .65, 'ParamEyeBallY': y * .65}})
state = run(c, 'keyform_apply', {'changes': changes}, pid, state)['state']
changes = []
for side in ('L', 'R'):
    for x, y in itertools.product((-1., 0., 1.), repeat=2):
        if x or y:
            changes.append({'op': 'copy', 'target': f'warp:DeformEyeGaze{side}', 'from': {'ParamEyeBallX': x * .65, 'ParamEyeBallY': y * .65}, 'key': {'ParamEyeBallX': x, 'ParamEyeBallY': y}})
state = run(c, 'keyform_apply', {'changes': changes}, pid, state)['state']
(output / f'{outfit}-eye-surface-report.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
print(json.dumps({'outfit': outfit, 'state': state, 'surfaces': reports, 'gaze_endpoint_travel': .65}))
