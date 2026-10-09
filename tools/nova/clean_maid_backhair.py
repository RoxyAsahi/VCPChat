"""Apply the handoff's fill-color approach to native back-hair layers.

Only color is corrected. Original alpha, size, layer placement and authored
keyforms remain unchanged. Filled purple/blue reconstruction regions use the
dark hair palette sampled from their actual hair strands.
"""
from pathlib import Path
import json,numpy as np
from PIL import Image,ImageFilter
import sys
if len(sys.argv)!=3:
    raise SystemExit("Usage: python -I clean_maid_backhair.py <helper tools directory> <extracted hair PNG directory>")
sys.path.insert(0,str(Path(sys.argv[1]).resolve()))
from p2l_mcp import Client
from p2l_v2 import run
root=Path(sys.argv[2]).resolve().parent
c=Client(); project=c.call('workspace_inspect',{'scope':'project'})['data'];pid=project['project_id'];state=project['state']
layers=c.call('workspace_inspect',{'scope':'layers','limit':64})['data']['items']
ids={x['name']:x['id'] for x in layers}
reports=[]
for name in ('back hair','back hair-r','back hair-l'):
    src=Path(sys.argv[2]).resolve()/(name.replace(' ','_')+'.png')
    original=np.array(Image.open(src).convert('RGBA')); a=original.copy();rgb=a[:,:,:3].astype(float)
    r,g,b=np.moveaxis(rgb,-1,0);lum=(r+g+b)/3
    strand=(a[:,:,3]>220)&(r>b+2)&(r>g+5)&(lum>35)&(lum<95)
    assert strand.sum()>100,name
    base=np.median(rgb[strand],axis=0)
    residue=(b>r+5)&(g>r-18)&(lum>95)&(a[:,:,3]>0)
    # Include the hard collar/earring outline immediately around the purple fill.
    mask=Image.fromarray((residue*255).astype('uint8')).filter(ImageFilter.MaxFilter(13)).filter(ImageFilter.GaussianBlur(1.5))
    amount=np.array(mask,dtype=float)/255
    # Preserve subtle strand luminance rather than flattening every corrected pixel.
    detail=np.clip((lum-140)*0.10,-10,10)
    fill=np.clip(base[None,None,:]+detail[:,:,None],0,255)
    a[:,:,:3]=np.clip(rgb*(1-amount[:,:,None])+fill*amount[:,:,None],0,255).astype('uint8')
    assert np.array_equal(a[:,:,3],original[:,:,3])
    dst=Path(sys.argv[2]).resolve()/(name.replace(' ','_')+'-clean.png')
    Image.fromarray(a).save(dst)
    state=run(c,'layer_replace_image',{'layer_id':ids[name],'path':str(dst.resolve()),'rebuild_mesh':False},pid,state)['state']
    reports.append({'layer':name,'residue_pixels':int(residue.sum()),'alpha_unchanged':True,'base_color':base.tolist()})
(root/'maid-hair-clean-report.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
print(json.dumps({'state':state,'layers':reports}))
