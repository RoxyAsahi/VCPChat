"""Copy PSD2Live MCP exports into self-contained outfits/<variant>/ folders.

usage: python -I finalize_outfits.py <fullbody dir>

Adds ParamBreath as an extra input to the vertical (_y) cloth/hair pendulums so the
skirt, apron and hair also settle with breathing (PSD2Live presets only read the angles).
"""
import json, os, shutil, sys

BREATH_WEIGHT = 12.0
OUTFITS = {'tech': {'name': '科技服', 'order': 1},
           'maid': {'name': '女仆', 'order': 2},
           'chibi': {'name': 'Q 版', 'order': 3}}
DESKPET = {'motions': {'happy': 'Nod', 'excited': 'Nod', 'curious': 'Nod', 'angry': 'Shake'}}

def add_breath(physics_path):
    data = json.load(open(physics_path, encoding='utf-8'))
    added = []
    for s in data['PhysicsSettings']:
        if s['Id'].startswith('PhysicsSim_') and s['Id'].endswith('_y') \
                and not any(i['Source']['Id'] == 'ParamBreath' for i in s['Input']):
            s['Input'].append({'Source': {'Target': 'Parameter', 'Id': 'ParamBreath'},
                               'Weight': BREATH_WEIGHT, 'Type': 'X', 'Reflect': False})
            added.append(s['Id'])
    data['Meta']['TotalInputCount'] = sum(len(s['Input']) for s in data['PhysicsSettings'])
    json.dump(data, open(physics_path, 'w', encoding='utf-8'), ensure_ascii=False, indent='\t')
    return added

def main(root):
    for v in ('tech', 'maid', 'chibi'):
        src = os.path.join(root, 'work', v, 'mcp')
        dst = os.path.join(root, 'outfits', v)
        if os.path.isdir(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns('_mcp_report.json'))
        # outfit menu label/order for the desk pet's 换装 menu, and emotion -> motion mapping
        json.dump(OUTFITS[v], open(os.path.join(dst, 'outfit.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        json.dump(DESKPET, open(os.path.join(dst, 'deskpet.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        added = add_breath(os.path.join(dst, f'nova_{v}.physics3.json'))
        model = json.load(open(os.path.join(dst, f'nova_{v}.model3.json'), encoding='utf-8'))
        refs = model['FileReferences']
        files = [refs['Moc'], refs['Physics'], refs['DisplayInfo'], *refs['Textures'],
                 *[m['File'] for g in refs['Motions'].values() for m in g]]
        missing = [f for f in files if os.path.isabs(f) or not os.path.exists(os.path.join(dst, f))]
        assert not missing, (v, missing)
        print(v, 'ok', 'breath ->', added, sorted(os.listdir(dst)))

if __name__ == '__main__':
    main(sys.argv[1])
