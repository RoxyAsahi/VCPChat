"""Replay the verified native mouth edits on the exact final gaze baseline.

Usage: python -I fix_mouth_arcs.py <helper-directory> <changes.json> <output-directory>
The caller supplies the isolated PSD2Live endpoint and authentication environment.
"""
from pathlib import Path
import sys,json,hashlib
if len(sys.argv)!=4:raise SystemExit(__doc__)
sys.path.insert(0,str(Path(sys.argv[1]).resolve()))
from p2l_mcp import Client
from p2l_v2 import run,export
changes_path=Path(sys.argv[2]).resolve();out=Path(sys.argv[3]).resolve();out.mkdir(parents=True,exist_ok=True)
changes=json.loads(changes_path.read_text(encoding='utf-8'))
assert len(changes)==18
assert {e['target'] for e in changes}=={'mesh:ArtMeshMouth','mesh:ArtMeshMouth_lip_0','mesh:ArtMeshMouth_lip_1'}
c=Client();p=c.call('workspace_inspect',{'scope':'project'})['data']
assert p['canvas']==[1024,1536] and p['parameters']==20
export(c,p['project_id'],p['state'],str(out/'baseline-verification'))
digest=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
before=digest(out/'baseline-verification/nova_tech.moc3')
assert before=='598e8968498b3180439f82161f8d57fde21aed944acc0b6d1369e381a588f04e', 'Open the final gaze baseline first; never reapply on an edited candidate.'
p=c.call('workspace_inspect',{'scope':'project'})['data']
r=run(c,'rig_deform',{'changes':changes},p['project_id'],p['state'])
(out/'author-diagnostics.json').write_text(json.dumps(r,indent=2),encoding='utf-8')
assert r['geometry_diagnostics']['safe']
p=c.call('workspace_inspect',{'scope':'project'})['data']
run(c,'project_save_as',{'path':str(out/'tech-mouth-fixed.psd2live')},p['project_id'],p['state'])
p=c.call('workspace_inspect',{'scope':'project'})['data'];export(c,p['project_id'],p['state'],str(out/'export'))
after=digest(out/'export/nova_tech.moc3')
assert after=='289814bed3adc37a4c338f04e4a1231ef33b7dc11155bcfc3677f4e263d53bc0'
print(json.dumps({'verified_original':before,'replayed':after,'saved':str(out/'tech-mouth-fixed.psd2live')}))
