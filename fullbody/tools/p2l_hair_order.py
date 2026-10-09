"""Chibi: PSD2Live put every face part (eyes, brows, blush, mouth, expression marks) above the front hair, so a brow
or blush shows through the bangs / side locks once the head turns.  Lift the front hair (and the headwear on it)
above the face parts, and the gesture arms (hands go in front of the face in Salute / Heart) above the hair,
keeping the arms' own order.  Every AngleX key of these meshes gets the value (the 0 key kept the old order).
usage: python p2l_hair_order.py"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client
from p2l_v2 import run
c = Client()
ins = c.call('workspace_inspect', {'scope': 'project'})['data']
# gesture arms bottom to top, as they render now
ARMS = ['ArtMeshHandwearL5', 'ArtMeshHandwearR5', 'ArtMeshHandwearL4', 'ArtMeshHandwearR4', 'ArtMeshHandwear3', 'ArtMeshHandwear2',
        'ArtMeshHandwear', 'ArtMeshHandwearL3', 'ArtMeshHandwearR3', 'ArtMeshHandwearL2', 'ArtMeshHandwearR2', 'ArtMeshHandwearL', 'ArtMeshHandwearR']
order = [('ArtMeshFrontHair', 980.0), ('ArtMeshHeadwear', 981.0)] + [(m, 985.0 + k) for k, m in enumerate(ARMS)]
ch = [{'op': 'set', 'target': f'mesh:{m}', 'key': {'ParamAngleX': x}, 'channels': {'drawOrder': v}} for m, v in order for x in (-45.0, 0.0, 45.0)]
print(json.dumps(run(c, 'keyform_apply', {'changes': ch}, ins['project_id'], ins['state']), ensure_ascii=False)[:300])
