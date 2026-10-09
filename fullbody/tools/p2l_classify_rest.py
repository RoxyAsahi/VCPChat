"""Classify the loaded PSD2Live project from layer_plan.json, one layer_classify per layer, skipping layers already matching."""
import json, os, sys, time, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
ROLE = {'facedetail': 'face_detail'}
plan = json.load(open(sys.argv[1], encoding='utf-8'))
c = Client()
lay, off = {}, 0
while off is not None:
    d = c.call('workspace_inspect', {'scope': 'layers', 'offset': off, 'limit': 64})['data']
    for it in d['items']: lay.setdefault(it['name'], it)
    off = d.get('next')
todo = []
for e in plan['layers']:
    if 'role' not in e: continue
    cur = lay[e['layer']]
    want = {'role': ROLE.get(e['role'], e['role']), 'side': e['side'], 'type': e['type']}
    if e['type'] != 'preset': want.update(parameter=e['parameter'], switch_id=e['switch_id'])
    if any(cur.get(k) != v for k, v in want.items()): todo.append((cur['id'], want))
print('todo', len(todo), flush=True)
for i, (lid, want) in enumerate(todo):
    s = c.call('workspace_inspect', {'scope': 'project'})['data']
    t = time.time()
    j = c.call('layer_classify', {'layer_id': lid, **want, 'request_id': 'cl-' + uuid.uuid4().hex[:10], 'project_id': s['project_id'], 'state': s['state']})
    d = c.wait(j) if 'status' in j.get('data', j) else j
    print(i + 1, lid, d.get('status'), round(time.time() - t, 1), flush=True)
    if d.get('status') != 'completed': print(json.dumps(d, ensure_ascii=False)[:1500]); break
