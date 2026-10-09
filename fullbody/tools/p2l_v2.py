"""Import a v2 PSD into a running PSD2Live, classify layers from layer_plan.json, presets, export.

usage: python p2l_v2.py <work-v2/<variant>> <out_dir> [<preset> ...]
Layers with a plan entry get role/side/type/parameter/switch_id; the rest keep the auto classification.
"""
import json, os, sys, time, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client

ROLE = {'facedetail': 'face_detail'}

def rid(tag): return f'{tag}-{uuid.uuid4().hex[:10]}'

def run(c, op, req, pid, state):
    job = c.call(op, {**req, 'request_id': rid(op), 'project_id': pid, 'state': state})
    if not job.get('ok', True):
        raise SystemExit(f'{op} refused: ' + json.dumps(job, ensure_ascii=False)[:2000])
    d = job.get('data', job)
    if 'status' in d and 'terminal' in d:
        d = c.wait(job)
        if d['status'] != 'completed':
            raise SystemExit(f'{op} {d["status"]}: ' + json.dumps(d.get('error'), ensure_ascii=False)[:2000])
        return d['result']
    return d

def main(work, out_dir, presets):
    variant = os.path.basename(os.path.normpath(work))
    plan = json.load(open(os.path.join(work, 'layer_plan.json'), encoding='utf-8'))
    c = Client()
    ins = c.call('workspace_inspect', {'scope': 'project'})['data']
    r = run(c, 'project_import_psd', {'path': os.path.abspath(os.path.join(work, f'nova_{variant}.psd')),
                                      'discard_unsaved': True}, ins.get('project_id'), ins['state'])
    pid, state = r['project_id'], r['state']
    st = c.call('workspace_inspect', {'scope': 'settings'})['data']
    if st.get('settings', {}).get('atlasSize') != 2048:
        state = run(c, 'settings_update', {'changes': {'atlasSize': 2048}}, pid, state)['state']
    ids, off = {}, 0
    while off is not None:
        d = c.call('workspace_inspect', {'scope': 'layers', 'offset': off, 'limit': 64})['data']
        for it in d['items']:
            ids.setdefault(it['name'], it['id'])
        off = d.get('next')
    t0 = time.time()
    edits = []
    for e in plan['layers']:
        if 'role' not in e:
            continue
        req = {'layer_id': ids[e['layer']], 'role': ROLE.get(e['role'], e['role']), 'side': e['side'],
               'type': e['type']}
        if e['type'] != 'preset':
            req['parameter'] = e['parameter']
            req['switch_id'] = e['switch_id']
        edits.append({'operation': 'layer_classify', 'request': req})
    # one rebuild for the whole plan instead of one per layer
    for i in range(0, len(edits), 128):
        state = run(c, 'workspace_apply_edits', {'summary': f'classify {variant} variants', 'edits': edits[i:i + 128]},
                    pid, state)['state']
    print('classified', len(edits), 'layers in', round(time.time() - t0, 1), 's')
    for p in presets:
        state = run(c, 'model_apply_preset', {'preset': p}, pid, state)['state']
        print('preset', p)
    with open(os.path.join(work, '_state.json'), 'w') as fp:
        json.dump({'project_id': pid, 'state': state}, fp)
    if out_dir != '-':
        export(c, pid, state, out_dir)

def export(c, pid, state, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    r = run(c, 'project_export_model', {'output_directory': os.path.abspath(out_dir)}, pid, state)
    print('export', json.dumps(r, ensure_ascii=False)[:1500])

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
