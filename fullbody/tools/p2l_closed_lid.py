"""Chibi closed eye.  PSD2Live's generated EyeOpen=0 form squashes the neutral lash to a hairline and leaves the cyan
eye-white peeking out.  At EyeOpen~0.3 the lash has already bent into a dark lid curve, so hold that shape down to 0,
and fade the eye-white (which carries the iris) out between 0.45 and 0.3 so no cyan is left once the lid is down.
usage: python p2l_closed_lid.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
pid, state = ins['project_id'], ins['state']
LID = 0.3
eyes = (('ParamEyeLOpen', 'ArtMeshEyewhiteL9', 'ArtMeshEyelashL8', 'ArtMeshFaceDetailL'),
        ('ParamEyeROpen', 'ArtMeshEyewhiteR8', 'ArtMeshEyelashR7', 'ArtMeshFaceDetailR2'))
ch = []
for eye, white, lash, arc in eyes:
    # an earlier attempt borrowed the happy-eye arc; put it back to Happy only
    for p in (eye, 'ParamExpNeutralHide'):
        ch.append({'op': 'delete', 'target': f'mesh:{arc}', 'parameter': p, 'channel': 'opacity'})
    ch.append({'op': 'delete', 'target': f'mesh:{lash}', 'parameter': eye, 'channel': 'opacity'})
    ch.append({'op': 'delete', 'target': f'mesh:{white}', 'parameter': eye, 'channel': 'opacity'})
state = run(c, 'keyform_apply', {'changes': ch}, pid, state)['state']
# deleting the axes collapsed the arc to its EyeOpen=0 value (1): re-key it to Happy alone
ch = [{'op': 'set', 'target': f'mesh:{arc}', 'key': {'ParamExpHappy': h}, 'channels': {'opacity': h}} for eye, white, lash, arc in eyes for h in (0.0, 1.0)]
state = run(c, 'keyform_apply', {'changes': ch}, pid, state)['state']
ch = []
for eye, white, lash, arc in eyes:
    ch.append({'op': 'seed', 'target': f'mesh:{lash}', 'key': {eye: LID}})
state = run(c, 'keyform_apply', {'changes': ch}, pid, state)['state']
ch = []
for eye, white, lash, arc in eyes:
    ch.append({'op': 'copy', 'target': f'mesh:{lash}', 'from': {eye: LID}, 'key': {eye: 0.0}})
    for hide in (0.0, 1.0):
        for eo, op in ((0.0, 0.0), (LID, 0.0), (0.45, 1.0), (1.0, 1.0)):
            ch.append({'op': 'set', 'target': f'mesh:{white}', 'key': {eye: eo, 'ParamExpNeutralHide': hide}, 'channels': {'opacity': 0.0 if hide else op}})
r = run(c, 'keyform_apply', {'changes': ch}, pid, state)
print(json.dumps(r, ensure_ascii=False)[:400])
for t in ('ArtMeshEyewhiteL9', 'ArtMeshEyelashL8', 'ArtMeshFaceDetailL', 'ArtMeshEyewhiteR8', 'ArtMeshEyelashR7', 'ArtMeshFaceDetailR2'):
    d = c.call('workspace_inspect', {'scope': 'objects', 'target': 'mesh:' + t})['data']
    print(t, d['forms'], d['axes'], json.dumps(d['channels']))
# the lash keeps its full opacity at every EyeOpen (only NeutralHide hides it)
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
ch = [{'op': 'set', 'target': f'mesh:{lash}', 'key': {eye: eo, 'ParamExpNeutralHide': hide}, 'channels': {'opacity': 1.0 - hide}}
      for eye, white, lash, arc in eyes for eo in (0.0, 1.0) for hide in (0.0, 1.0)]
print(json.dumps(run(c, 'keyform_apply', {'changes': ch}, ins['project_id'], ins['state']), ensure_ascii=False)[:200])
