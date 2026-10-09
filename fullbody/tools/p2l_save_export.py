"""Save the open PSD2Live project and export the model.  usage: python p2l_save_export.py <save .psd2live> <export dir>"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run, export
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
r = run(c, 'project_save_as', {'path': os.path.abspath(sys.argv[1])}, ins['project_id'], ins['state'])
print('saved', json.dumps(r, ensure_ascii=False)[:300])
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
export(c, ins['project_id'], ins['state'], sys.argv[2])
