from pathlib import Path
import argparse,json,sys,hashlib
p=argparse.ArgumentParser(description="Author Nova expression geometry through the private PSD2Live API")
p.add_argument('--helpers',required=True,help='Folder containing p2l_mcp.py and p2l_v2.py')
p.add_argument('--project',required=True,help='Input editable .psd2live project')
p.add_argument('--output',required=True,help='New output directory')
p.add_argument('--variant',required=True,choices=['tech','maid'])
p.add_argument('--asset',required=True,help='Transparent cheek overlay PNG')
args=p.parse_args()
sys.path.insert(0,str(Path(args.helpers).resolve()))
from p2l_mcp import Client
from p2l_v2 import run,export
root=Path(args.output).resolve()
root.mkdir(parents=True,exist_ok=True)
variant=args.variant
config={
    'tech':{'face':'face#11','bounds':[('R',[450,170,43,24]),('L',[536,164,43,24])],'canvas':[1024,1536]},
    'maid':{'face':'face#17','bounds':[('R',[309,235,45,25]),('L',[402,224,45,25])],'canvas':[766,1551]},
}[variant]
c=Client()
p=c.call('workspace_inspect',{'scope':'project'})['data']
opened=run(c,'project_open',{'path':str(Path(args.project).resolve()),'discard_unsaved':False},p['project_id'],p['state'])
pid,state=opened['project_id'],opened['state']
p=c.call('workspace_inspect',{'scope':'project'})['data']
assert p['parameters']==24 and p['canvas']==config['canvas'],p
target=root/f'{variant}-cheek-asset-trial.psd2live'
assert not target.exists(), 'Choose a new output directory; existing projects are preserved'
state=run(c,'project_save_as',{'path':str(target)},pid,state)['state']
side,bounds=config['bounds'][0]
ref=run(c,'asset_prepare_reference',{'layer_id':config['face'],'piece_id':'nova-cheek-reference','background_color':'#000000','target_anchors':{'left':{'x':bounds[0],'y':bounds[1]},'right':{'x':bounds[0]+bounds[2],'y':bounds[1]}},'source_canvas_rect':dict(zip(['left','top','width','height'],bounds))},pid,state)
state=ref['state']
asset=run(c,'asset_import_png',{'png_path':str(Path(args.asset).resolve()),'reference_id':ref['id'],'require_transparency':True},pid,state)
state=asset['state']
edits=[]
for side,bounds in config['bounds']:
    registration=run(c,'asset_register',{'asset_id':asset['assetId'],'reference_id':ref['id'],'mode':'frame','source_canvas_rect':dict(zip(['left','top','width','height'],bounds)),'allow_stretch':True},pid,state)
    state=registration['state']
    edits.append({'operation':'layer_add_from_asset','request':{'asset_id':asset['assetId'],'registration_id':registration['id'],'name':'cheek-'+side,'layer_id':'agent:nova-cheek-'+side,'semantic_tag':'face_detail','side':'right' if side=='R' else 'left','insertion':{'mode':'above','reference_layer_id':config['face']},'opacity':1}})
state=run(c,'workspace_apply_edits',{'summary':'Add both registered cheek layers','edits':edits},pid,state)['state']
updated=run(c,'rig_update_generation',{},pid,state)
assert not updated.get('issues'),updated
state=updated['state']
targets=[]
for side in ['L','R']:
    target_mesh='mesh:ArtMeshFaceDetail'+side
    obj=c.call('workspace_inspect',{'scope':'objects','target':target_mesh})
    assert obj['ok'] and obj['data']['parent']=='DeformFaceContour' and not obj['data']['axes'],obj
    targets.append(target_mesh)
state=run(c,'parameter_create',{'parameter_id':'ParamCheek','name':'Cheek blush','min':0,'max':1,'default':0},pid,state)['state']
changes=[]
for target_mesh in targets:
    for value,opacity in [(0,0),(1,.65)]:
        changes.extend([{'op':'seed','target':target_mesh,'key':{'ParamCheek':value}},{'op':'set','target':target_mesh,'key':{'ParamCheek':value},'channels':{'opacity':opacity}}])
state=run(c,'keyform_apply',{'changes':changes},pid,state)['state']
state=run(c,'project_save_as',{'path':str(target)},pid,state)['state']
export(c,pid,state,str(root/f'{variant}-cheek-asset-trial'))
report={'input_project_sha256':hashlib.sha256(Path(args.project).read_bytes()).hexdigest(),'overlay_sha256':hashlib.sha256(Path(args.asset).read_bytes()).hexdigest(),'variant':variant,'reference':ref,'asset':asset,'layer_edits':edits,'generation_update':updated,'opacity_changes':changes,'project_path':str(target)}
(root/'authoring.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(variant,'saved 25-parameter model with both real cheeks',flush=True)
