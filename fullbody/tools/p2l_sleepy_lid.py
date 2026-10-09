"""Chibi Tired / sleep eyes.  The sleepy eye set (ParamExpSleepy) squashes with EyeOpen like any eye, but its eye-white
(which carries the iris) stays opaque, so a cyan sliver is left under the lid while the pet sleeps (EyeOpen 0).
Fade it out below EyeOpen 0.3, the same way p2l_closed_lid.py does for the neutral eyes.
usage: python p2l_sleepy_lid.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
ch = [{'op': 'set', 'target': f'mesh:{white}', 'key': {eye: eo, 'ParamExpSleepy': s}, 'channels': {'opacity': op * s}}
      for eye, white in (('ParamEyeLOpen', 'ArtMeshEyewhiteL6'), ('ParamEyeROpen', 'ArtMeshEyewhiteR5'))
      for s in (0.0, 1.0) for eo, op in ((0.0, 0.0), (0.15, 0.0), (0.3, 1.0), (1.0, 1.0))]
print(json.dumps(run(c, 'keyform_apply', {'changes': ch}, ins['project_id'], ins['state']), ensure_ascii=False)[:300])
for t in ('ArtMeshEyewhiteL6', 'ArtMeshEyewhiteR5'):
    d = c.call('workspace_inspect', {'scope': 'objects', 'target': 'mesh:' + t})['data']
    print(t, json.dumps(d['channels']))
