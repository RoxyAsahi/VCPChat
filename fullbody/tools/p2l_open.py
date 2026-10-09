"""Open a .psd2live in the running PSD2Live and print layer type counts. usage: python p2l_open.py <file>"""
import collections, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
t0 = time.time()
r = run(c, 'project_open', {'path': os.path.abspath(sys.argv[1]), 'discard_unsaved': True}, ins.get('project_id'), ins['state'])
print('open', round(time.time() - t0, 1), 's', json.dumps(r, ensure_ascii=False)[:600])
cnt, off, items = collections.Counter(), 0, []
while off is not None:
    d = c.call('workspace_inspect', {'scope': 'layers', 'offset': off, 'limit': 64})['data']
    items += d['items']; off = d.get('next')
for it in items: cnt[(it.get('type'), it.get('parameter'))] += 1
print(len(items), 'layers'); print(json.dumps(items[0], ensure_ascii=False)[:500])
for k, v in sorted(cnt.items(), key=str): print(k, v)
