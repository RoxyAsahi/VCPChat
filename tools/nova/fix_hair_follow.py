"""Counter-bend long back hair while preserving its existing sway and roots."""
import json
import sys,pathlib
if len(sys.argv)!=2:
    raise SystemExit("Usage: python -I fix_hair_follow.py <PSD2Live helper tools directory>")
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).resolve()))
from p2l_mcp import Client
from p2l_v2 import run
c=Client(); p=c.call('workspace_inspect',{'scope':'project'})['data']; pid=p['project_id']; state=p['state']
target='warp:DeformHairBackPhysics'
obj=c.call('workspace_inspect',{'scope':'objects','target':target})['data']
assert obj['axes']=={'ParamHairBack':[-1.0,0.0,1.0]},obj['axes']
changes=[{'op':'seed','target':target,'key':{'ParamHairBack':sway,'ParamAngleZ':z}}
         for sway in (-1.,0.,1.) for z in (-30.,-15.,-8.,0.,8.,15.,30.)]
state=run(c,'keyform_apply',{'changes':changes},pid,state)['state']
changes=[{'target':target,'key':{'ParamHairBack':sway,'ParamAngleZ':z},
          'operations':[{'type':'arc','degrees':-1.2*z,'root':[0.5,0.1],'tip':[0.5,0.95],'root_pin':0.18}]}
         for sway in (-1.,0.,1.) for z in (-30.,-15.,-8.,8.,15.,30.)]
state=run(c,'rig_deform',{'changes':changes},pid,state)['state']
print(json.dumps({'project_id':pid,'state':state,'preserved_sway':True,'root_pin':0.18}))
