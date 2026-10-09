import sys, json, re
sys.path.insert(0, 'C:/Users/CHENXI/Documents/Codex/nova-live2d/fullbody/tools')
from p2l_mcp import Client
c = Client(); off = 0; out = []
while off is not None:
    d = c.call('workspace_inspect', {'scope': 'objects', 'limit': 64, 'offset': off})['data']
    out += d['items']; off = d.get('next')
pat = re.compile(sys.argv[1], re.I)
for o in out:
    if not pat.search(o['name']): continue
    t = o['target']
    if not t.startswith('mesh:'): print(o['name'], t); continue
    d = c.call('workspace_inspect', {'scope': 'objects', 'target': t})['data']
    print(o['name'], '|', t, '| axes', d['axes'], '| opacity', json.dumps(d['channels'])[:700], d['forms'])
