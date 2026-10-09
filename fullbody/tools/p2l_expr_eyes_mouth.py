"""Chibi expressions: closed eye and lip sync for every expression set (the neutral set has them already).

Eyes: each expression's lash holds its EyeOpen 0.3 lid curve down to 0, and its eye-white (which carries the iris)
fades out between EyeOpen 0.45 and 0.3, as p2l_closed_lid.py does for the neutral set.  Stars has no lash: below 0.3
the star fades and the neutral lash lid shows instead.  Tired keeps its own lash, only its eye-white fade moves up.
Mouth: an expression mouth has no open state and NeutralHide hid the only mouth keyed on MouthOpenY, so talking under
an expression showed a frozen mouth.  Above MouthOpenY 0.1 the expression mouth now fades out and the neutral talk mouth
fades in (fully by 0.3); MouthForm from the expression still shapes it.
usage: python p2l_expr_eyes_mouth.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
LID = 0.3
EYES = {  # expression parameter: ((EyeOpen param, eye-white mesh, lash mesh or None), ...)
    'ParamExpAngry': (('ParamEyeLOpen', 'ArtMeshEyewhiteL10', 'ArtMeshEyelashL9'), ('ParamEyeROpen', 'ArtMeshEyewhiteR9', 'ArtMeshEyelashR8')),
    'ParamExpSad': (('ParamEyeLOpen', 'ArtMeshEyewhiteL8', 'ArtMeshEyelashL7'), ('ParamEyeROpen', 'ArtMeshEyewhiteR7', 'ArtMeshEyelashR6')),
    'ParamExpShy': (('ParamEyeLOpen', 'ArtMeshEyewhiteL7', 'ArtMeshEyelashL6'), ('ParamEyeROpen', 'ArtMeshEyewhiteR6', 'ArtMeshEyelashR5')),
    'ParamExpSmug': (('ParamEyeLOpen', 'ArtMeshEyewhiteL5', 'ArtMeshEyelashL4'), ('ParamEyeROpen', 'ArtMeshEyewhiteR4', 'ArtMeshEyelashR3')),
    'ParamExpSpeechless': (('ParamEyeLOpen', 'ArtMeshEyewhiteL4', 'ArtMeshEyelashL3'), ('ParamEyeROpen', 'ArtMeshEyewhiteR3', 'ArtMeshEyelashR2')),
    'ParamExpSurprised': (('ParamEyeLOpen', 'ArtMeshEyewhiteL2', 'ArtMeshEyelashL2'), ('ParamEyeROpen', 'ArtMeshEyewhiteR', 'ArtMeshEyelashR')),
    'ParamExpWink': (('ParamEyeLOpen', 'ArtMeshEyewhiteL', 'ArtMeshEyelashL'),),
    'ParamExpStars': (('ParamEyeLOpen', 'ArtMeshEyewhiteL3', None), ('ParamEyeROpen', 'ArtMeshEyewhiteR2', None)),
    # Tired's lash is already a lid; its eye-white faded only below 0.3 (p2l_sleepy_lid.py), so cyan showed mid-blink
    'ParamExpSleepy': (('ParamEyeLOpen', 'ArtMeshEyewhiteL6', None), ('ParamEyeROpen', 'ArtMeshEyewhiteR5', None)),
}
NEUTRAL_LASH = (('ParamEyeLOpen', 'ArtMeshEyelashL8'), ('ParamEyeROpen', 'ArtMeshEyelashR7'))
MOUTHS = {'ParamExpWink': 'ArtMeshFaceDetail', 'ParamExpSurprised': 'ArtMeshFaceDetail3', 'ParamExpStars': 'ArtMeshFaceDetail4',
          'ParamExpSpeechless': 'ArtMeshFaceDetail6', 'ParamExpSmug': 'ArtMeshFaceDetail8', 'ParamExpSleepy': 'ArtMeshFaceDetail10',
          'ParamExpShy': 'ArtMeshFaceDetail12', 'ParamExpSad': 'ArtMeshFaceDetail14', 'ParamExpHappy': 'ArtMeshFaceDetail17',
          'ParamExpAngry': 'ArtMeshFaceDetail19'}
TALK = ('ArtMeshMouth', 'ArtMeshMouth_lip_0', 'ArtMeshMouth_lip_1')
FADE = ((0.0, 1.0), (0.1, 1.0), (0.3, 0.0), (1.0, 0.0))   # MouthOpenY -> expression mouth opacity

c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
pid, state = ins['project_id'], ins['state']
def axes(m): return c.call('workspace_inspect', {'scope': 'objects', 'target': 'mesh:' + m})['data']['axes']
ch = [{'op': 'seed', 'target': f'mesh:{lash}', 'key': {eye: LID}} for e in EYES.values() for eye, white, lash in e
      if lash and LID not in axes(lash).get(eye, [])]
if ch:
    state = run(c, 'keyform_apply', {'changes': ch}, pid, state)['state']
ch = [{'op': 'copy', 'target': f'mesh:{lash}', 'from': {eye: LID}, 'key': {eye: 0.0}} for e in EYES.values() for eye, white, lash in e if lash]
for p, e in EYES.items():
    for eye, white, lash in e:
        for s in (0.0, 1.0):
            for eo, op in ((0.0, 0.0), (0.15, 0.0), (LID, 0.0), (0.45, 1.0), (1.0, 1.0)):
                ch.append({'op': 'set', 'target': f'mesh:{white}', 'key': {eye: eo, p: s}, 'channels': {'opacity': op * s}})
# neutral lash: shown when the neutral set is, and as the Stars lid below EyeOpen 0.3
for eye, lash in NEUTRAL_LASH:
    for hide in (0.0, 1.0):
        for st in (0.0, 1.0):
            for eo in (0.0, LID, 0.45, 1.0):
                ch.append({'op': 'set', 'target': f'mesh:{lash}', 'key': {eye: eo, 'ParamExpNeutralHide': hide, 'ParamExpStars': st},
                           'channels': {'opacity': 1.0 if hide == 0 else (1.0 if st == 1 and eo <= LID else 0.0)}})
for p, m in MOUTHS.items():
    for s in (0.0, 1.0):
        for mo, op in FADE:
            ch.append({'op': 'set', 'target': f'mesh:{m}', 'key': {'ParamMouthOpenY': mo, p: s}, 'channels': {'opacity': op * s}})
for m in TALK:
    for hide in (0.0, 1.0):
        for mo, op in FADE:
            ch.append({'op': 'set', 'target': f'mesh:{m}', 'key': {'ParamMouthOpenY': mo, 'ParamExpNeutralHide': hide},
                       'channels': {'opacity': 1.0 if hide == 0 else 1.0 - op}})
# the neutral closed mouth cross-faded linearly over the whole MouthOpenY range and muddied the half-open mouth
for hide in (0.0, 1.0):
    for mo, op in FADE:
        ch.append({'op': 'set', 'target': 'mesh:ArtMeshMouthClose', 'key': {'ParamMouthOpenY': mo, 'ParamExpNeutralHide': hide},
                   'channels': {'opacity': 0.0 if hide else op}})
for i in range(0, len(ch), 64):
    r = run(c, 'keyform_apply', {'changes': ch[i:i + 64]}, pid, state); state = r['state']
print(len(ch), 'changes', json.dumps(r, ensure_ascii=False)[:300])
for t in ('ArtMeshEyewhiteL8', 'ArtMeshEyelashL7', 'ArtMeshEyelashL8', 'ArtMeshFaceDetail', 'ArtMeshMouth', 'ArtMeshMouthClose', 'ArtMeshEyewhiteL6'):
    d = c.call('workspace_inspect', {'scope': 'objects', 'target': 'mesh:' + t})['data']
    print(t, d['forms'], d['axes'], json.dumps([x for x in d['channels'] if x['channel'] == 'opacity']))
