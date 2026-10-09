"""Write every layer classification of layer_plan.json into a saved .psd2live in one step.

usage: python p2l_patch_overrides.py <saved.psd2live> <layer_plan.json> <out.psd2live>
Each layer_classify through the API appends a ~1 MB rig_generation_transition to the journal and every later
rebuild replays them all, so 86 classifications take hours. Here a new head revision is added on top of the
import revision (empty journal) with all overrides in its layers node; opening it generates the rig once.
Layer ids come from the source node.
"""
import hashlib, json, sys, uuid, zipfile, datetime
TAG = {'facedetail': 'FACE_DETAIL'}
def sha(b): return hashlib.sha256(b).hexdigest()
def dumps(v): return json.dumps(v, ensure_ascii=False, separators=(',', ':')).encode()

src, plan_path, dst = sys.argv[1:4]
plan = json.load(open(plan_path, encoding='utf-8'))
zin = zipfile.ZipFile(src)
files = {n: zin.read(n) for n in zin.namelist()}
src_node = json.loads(next(v for k, v in files.items() if k.startswith('document/nodes/source/')))
ids = {}
for l in src_node['value']['layers']: ids.setdefault(l['name'], l['id'])
head = json.loads(files['history/HEAD.json'])
root_id = head['nodeOrder'][0]
nodes = {json.loads(v)['id']: (k, json.loads(v)) for k, v in files.items() if k.startswith('history/nodes/')}
root = nodes[root_id][1]
rev_key = sha(root['snapshotHash'].encode())
rev = json.loads(files[f'history/revisions/{rev_key}.json'])
assert json.loads(files[f'document/nodes/journal/{rev["nodes"]["journal"]}.json'])['value']['entries'] == []
layers = json.loads(files[f'document/nodes/layers/{rev["nodes"]["layers"]}.json'])
ov = {}
for e in plan['layers']:
    if 'role' not in e: continue
    ov[ids[e['layer']]] = {'type': e['type'].upper(), 'tag': TAG.get(e['role'], e['role'].upper()), 'side': e['side'].upper(),
                               'parameter': e['parameter'] if e['type'] != 'preset' else '', 'switchId': e['switch_id'] if e['type'] != 'preset' else 0}
layers['value']['layerOverrides'] = dict(sorted(ov.items()))
lb = dumps(layers); lh = sha(lb)
files[f'document/nodes/layers/{lh}.json'] = lb
rev['nodes']['layers'] = lh
rb = dumps(rev)
rid = 'revision-' + sha(rb)
files[f'history/revisions/{sha(rid.encode())}.json'] = rb
nid = f'history-{uuid.uuid4()}'
node = {'version': 1, 'id': nid, 'parentId': root_id, 'revisionId': rid, 'snapshotHash': rid,
        'summary': f'Classified {len(ov)} layers from layer_plan.json', 'actor': 'agent',
        'createdAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')}
files[f'history/nodes/{sha(nid.encode())}.json'] = json.dumps(node, indent=4).encode()
head['headNodeId'] = nid; head['nodeOrder'].append(nid)
files['history/HEAD.json'] = json.dumps(head, indent=4).encode()
man = json.loads(files.pop('manifest.json'))
man['files'] = {k: sha(v) for k, v in sorted(files.items())}
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for k, v in files.items():
        z.writestr(k, v, compress_type=zipfile.ZIP_STORED if k.endswith('.png') else zipfile.ZIP_DEFLATED)
    z.writestr('manifest.json', json.dumps(man, indent=4))
print('overrides', len(ov), 'head', nid, rid)
