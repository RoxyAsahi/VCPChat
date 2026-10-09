from pathlib import Path
import argparse,json,sys,hashlib
p=argparse.ArgumentParser(description="Author Nova expression geometry through the private PSD2Live API")
p.add_argument('--helpers',required=True,help='Folder containing p2l_mcp.py and p2l_v2.py')
p.add_argument('--project',required=True,help='Input editable .psd2live project')
p.add_argument('--output',required=True,help='New output directory')
p.add_argument('--variant',required=True,choices=['tech','maid'])

args=p.parse_args()
sys.path.insert(0,str(Path(args.helpers).resolve()))
from p2l_mcp import Client
from p2l_v2 import run,export
root=Path(args.output).resolve()
root.mkdir(parents=True,exist_ok=True)
variant=args.variant
c = Client()
initial=c.call('workspace_inspect',{'scope':'project'})['data']
assert not (root/f'{variant}-expression-trial.psd2live').exists(), 'Choose a new output directory'
run(c,'project_open',{'path':str(Path(args.project).resolve()),'discard_unsaved':False},initial['project_id'],initial['state'])
project = c.call('workspace_inspect', {'scope': 'project'})['data']
pid, state = project['project_id'], project['state']
parameters = c.call('workspace_inspect', {'scope': 'parameters', 'limit': 64})['data']['items']
assert len(parameters) == 20, 'Expected untouched final mouth baseline with 20 parameters'
targets = {}
for side in ['L', 'R']:
    for part in ['Eye', 'Brow']:
        target = f'warp:Deform{part}Shape{side}'
        obj = c.call('workspace_inspect', {'scope': 'objects', 'target': target})['data']
        assert obj['forms'] == 27 and set(obj['axes']) == {'ParamAngleX', 'ParamAngleY', 'ParamBodyLean'}
        targets[target] = obj['axes']
state = run(c, 'project_save_as', {'path': str(root / f'{variant}-expression-trial.psd2live')}, pid, state)['state']
requests = []
for side in ['L', 'R']:
    for part in ['Eye', 'Brow']:
        target = f'warp:Deform{part}Shape{side}'
        axes = targets[target]
        shapes = []
        for values in itertools.product(*axes.values()):
            key = dict(zip(axes, values))
            for value in ([1] if part == 'Eye' else [-1, 1]):
                if part == 'Eye':
                    operations = [{'type': 'scale', 'factors': [1, .8], 'pivot': [.5, .2]},
                                  {'type': 'translate', 'delta': [0, -.035], 'selection': {'center': [.5, .9], 'radius': .7, 'feather': .5}}]
                else:
                    operations = [{'type': 'rotate', 'degrees': value * (12 if side == 'L' else -12), 'pivot': [.5, .5]}]
                shapes.append({'target': target, 'value': value, 'key': key, 'operations': operations})
        parameter_id = f'ParamEye{side}Smile' if part == 'Eye' else f'ParamBrow{side}Angle'
        req = {'summary': f'{variant} Nova {parameter_id} across existing head poses',
               'parameter': {'id': parameter_id, 'name': parameter_id, 'min': 0 if part == 'Eye' else -1, 'max': 1, 'default': 0}, 'shapes': shapes}
        requests.append(req)
        state = run(c, 'author_axis', req, pid, state)['state']
        print(parameter_id, len(shapes), 'shapes authored', flush=True)
    
state = run(c, 'project_save_as', {'path': str(root / f'{variant}-expression-trial.psd2live')}, pid, state)['state']
export(c, pid, state, str(root / f'{variant}-expression-trial'))
(root / 'axis-requests.json').write_text(json.dumps(requests, indent=2), encoding='utf-8')
result = c.call('workspace_inspect', {'scope': 'parameters', 'limit': 64})
(root / 'authored-parameters.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print('saved independent trial; production assets unchanged', flush=True)
