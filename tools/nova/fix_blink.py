"""Persist eyelid coverage and foreground hair order in the current tech or maid rig."""
import sys, pathlib
if len(sys.argv) != 2:
    raise SystemExit("Usage: python -I fix_blink.py <PSD2Live helper tools directory>")
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve()))
from p2l_mcp import Client
from p2l_v2 import run
import json
c=Client(); p=c.call('workspace_inspect',{'scope':'project'})['data']; pid=p['project_id']; state=p['state']
changes=[]
for side in ('L','R'):
    eye=f'ParamEye{side}Open'; lash=f'mesh:ArtMeshEyelash{side}'
    changes.append({'op':'seed','target':lash,'key':{eye:0.3}})
state=run(c,'keyform_apply',{'changes':changes},pid,state)['state']
changes=[]
for side in ('L','R'):
    eye=f'ParamEye{side}Open'; lash=f'mesh:ArtMeshEyelash{side}'
    changes.append({'op':'copy','target':lash,'from':{eye:0.3},'key':{eye:0.0}})
    for value,opacity in ((0.,0.),(0.3,0.),(0.5,1.),(1.,1.)):
        changes.append({'op':'set','target':f'mesh:ArtMeshEyewhite{side}','key':{eye:value},'channels':{'opacity':opacity}})
        for form in (-1.,0.,1.):
            changes.append({'op':'set','target':f'mesh:ArtMeshIrides{side}','key':{eye:value,'ParamEyeBallForm':form},'channels':{'opacity':opacity}})
state=run(c,'keyform_apply',{'changes':changes},pid,state)['state']
changes=[{'op':'set','target':f'mesh:{mesh}','key':{'ParamAngleX':x},'channels':{'drawOrder':order}}
    for mesh,order in [('ArtMeshFrontHair',980.),('ArtMeshHeadwear',981.)] for x in (-45.,0.,45.)]
state=run(c,'keyform_apply',{'changes':changes},pid,state)['state']
print(json.dumps({'project_id':pid,'state':state,'fixed':'blink coverage and hair draw order'}))
