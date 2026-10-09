from pathlib import Path
import json,itertools,math,sys
from PIL import Image,ImageChops
r=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else sys.exit('Usage: python check_expression_results.py OUTPUT_DIR')
result=json.loads((r/'result.json').read_text(encoding='utf-8'))
assert not result['errors'],result['errors']
failed=[x for x in result['assertions'] if not x['passed']]
assert not failed,failed
ids=['ParamMouthForm','ParamEyeBallForm','ParamBrowLY','ParamBrowRY','ParamEyeLSmile','ParamEyeRSmile','ParamBrowLAngle','ParamBrowRAngle','ParamCheek']
summary={}
for variant in ['tech','maid']:
    snapshots=json.loads((r/f'{variant}-snapshots.json').read_text(encoding='utf-8'))
    normal={s['emotion']:s for s in snapshots if s['pose']=='normal'}
    assert len(normal)==12
    signatures={name:{id:s['parameters'][id] for id in ids} for name,s in normal.items()}
    pairs=[]
    for first,second in itertools.combinations(signatures,2):
        delta=max(abs(signatures[first][id]-signatures[second][id]) for id in ids)
        assert delta>.02,(variant,first,second,delta)
        pairs.append(delta)
    counts={}
    for first,second in [('happy','sad'),('angry','shy'),('happy','excited'),('neutral','calm')]:
        a=Image.open(r/f'{variant}-{first}.png').convert('RGB')
        b=Image.open(r/f'{variant}-{second}.png').convert('RGB')
        diff=ImageChops.difference(a,b)
        count=sum(1 for p in diff.getdata() if max(p)>8)
        assert count>30,(variant,first,second,count)
        counts[first+'/'+second]=count
    summary[variant]={'emotions':len(normal),'poses':len(snapshots),'distinct_pairs':len(pairs),'minimum_parameter_difference':min(pairs),'pixel_difference_counts':counts,'actual_expression_parameters':signatures}
(r/'expression-distinction.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps({'renderer_assertions':len(result['assertions']),'errors':len(result['errors']),'outfits':{k:{a:b for a,b in v.items() if a!='actual_expression_parameters'} for k,v in summary.items()}}))
