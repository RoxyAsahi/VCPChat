"""Hide the lip-sync mouth (mouth open/close) while ParamExpNeutralHide=1, i.e. while an expression's own mouth shows.
usage: python p2l_mouth_hide.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
ch = []
for open_y in (0.0, 1.0):
    for hide, close_op in ((0.0, 1.0 - open_y), (1.0, 0.0)):
        ch.append({'op': 'set', 'target': 'mesh:ArtMeshMouthClose', 'key': {'ParamMouthOpenY': open_y, 'ParamExpNeutralHide': hide},
                   'channels': {'opacity': close_op}})
# the open mouth and the lip lines PSD2Live generates around it would otherwise ghost under an expression's own mouth
for mesh in ('ArtMeshMouth', 'ArtMeshMouth_lip_0', 'ArtMeshMouth_lip_1'):
    for hide in (0.0, 1.0):
        ch.append({'op': 'set', 'target': f'mesh:{mesh}', 'key': {'ParamExpNeutralHide': hide}, 'channels': {'opacity': 1.0 - hide}})
r = run(c, 'keyform_apply', {'changes': ch}, ins['project_id'], ins['state'])
print(json.dumps(r, ensure_ascii=False)[:800])
for t in ('mesh:ArtMeshMouthClose', 'mesh:ArtMeshMouth', 'mesh:ArtMeshMouth_lip_0', 'mesh:ArtMeshMouth_lip_1'):
    d = c.call('workspace_inspect', {'scope': 'objects', 'target': t})['data']
    print(t, d['axes'], d['channels'])
