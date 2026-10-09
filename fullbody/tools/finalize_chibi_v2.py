"""Drop the PSD2Live chibi export into Codex's built-in NovaChibi folder with expressions, gesture motions and deskpet.json.

usage: python finalize_chibi_v2.py <export dir> <assets/deskpet/nova/chibi>
Keeps Codex's idle/blink/nod/shake motions, portraits and outfit.json; replaces moc3/cdi3/physics3/texture.
"""
import json, os, shutil, sys

# Codex's parameter tweaks (Codex README), minus MouthOpenY/EyeOpen (the art already draws the open mouth and
# sleepy eyes) and ParamCheek (no such parameter; blush is in the expression art).
EXPRESSIONS = {
    'Neutral': {},
    'Happy': {'ParamExpHappy': 1, 'ParamMouthForm': 0.8, 'ParamEyeBallForm': 0.2, 'ParamBrowLY': 0.2, 'ParamBrowRY': 0.2},
    'Shy': {'ParamExpShy': 1, 'ParamMouthForm': 0.4, 'ParamBrowLY': 0.25, 'ParamBrowRY': 0.25},
    'Sad': {'ParamExpSad': 1, 'ParamMouthForm': -0.65, 'ParamBrowLY': 0.45, 'ParamBrowRY': 0.45},
    'Angry': {'ParamExpAngry': 1, 'ParamMouthForm': -0.4, 'ParamBrowLY': -0.65, 'ParamBrowRY': -0.65},
    'Surprised': {'ParamExpSurprised': 1, 'ParamBrowLY': 0.7, 'ParamBrowRY': 0.7},
    'Tired': {'ParamExpSleepy': 1, 'ParamMouthForm': -0.1},
    'Stars': {'ParamExpStars': 1, 'ParamBrowLY': 0.3, 'ParamBrowRY': 0.3},
    'Wink': {'ParamExpWink': 1, 'ParamMouthForm': 0.6},
    'Smug': {'ParamExpSmug': 1, 'ParamBrowLY': -0.15, 'ParamBrowRY': -0.15},
    'Speechless': {'ParamExpSpeechless': 1},
}
# gesture -> (toggle, head motion curves as (param, [(t, v)...]))
SWAY = lambda p, a: (p, [(0, 0), (0.5, a), (1.2, -a * 0.6), (1.9, a * 0.4), (2.5, 0)])
GESTURES = {
    'Wave': ('ParamActWave', [SWAY('ParamAngleZ', 8)]),
    'Salute': ('ParamActSalute', [SWAY('ParamAngleY', 6)]),
    'Heart': ('ParamActHeart', [SWAY('ParamAngleZ', -6), SWAY('ParamBodyAngleZ', -3)]),
    'Tea': ('ParamActTea', [SWAY('ParamAngleY', -5)]),
    'Typing': ('ParamActTyping', [SWAY('ParamAngleY', -8), SWAY('ParamAngleX', 4)]),
    'Shrug': ('ParamActShrug', [SWAY('ParamAngleZ', 7), SWAY('ParamBodyAngleY', 3)]),
    'Akimbo': ('ParamActAkimbo', [SWAY('ParamAngleX', -6), SWAY('ParamBodyAngleZ', 3)]),
    'Cheer': ('ParamActCheer', [SWAY('ParamAngleY', 8), SWAY('ParamBodyAngleY', 4)]),
}
DURATION = 2.5
DESKPET = {
    'name': 'Nova · 简洁 Q 版',
    'expressions': {'neutral': 'Neutral', 'calm': 'Neutral', 'happy': 'Happy', 'excited': 'Stars', 'shy': 'Shy',
                    'affectionate': 'Wink', 'curious': 'Smug', 'surprised': 'Surprised', 'concerned': 'Speechless',
                    'sad': 'Sad', 'tired': 'Tired', 'angry': 'Angry'},
    'motions': {
        # emotion changes
        'happy': 'Cheer', 'excited': 'Cheer', 'shy': 'Heart', 'affectionate': 'Heart', 'curious': 'Wave',
        'concerned': 'Shrug', 'sad': 'Shrug', 'tired': 'Tea', 'angry': 'Akimbo', 'surprised': 'Nod',
        # life actions
        'headTap': 'Nod', 'pat': 'Heart', 'annoyed': 'Akimbo', 'dizzy': 'Shake', 'yawn': 'Tea', 'stretch': 'Salute',
        'hum': 'Typing', 'wake': 'Wave', 'landed': 'Cheer'},
}

def dump(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2); f.write('\n')

def motion(curves):
    out, segs, pts = [], 0, 0
    for pid, keys, *cut in curves:
        s = [float(keys[0][0]), float(keys[0][1])]
        for t, v, *step in keys[1:]:
            s += [2 if step else 0, float(t), float(v)]
        c = {'Target': 'Parameter', 'Id': pid, 'Segments': s}
        if cut:   # toggles switch art on/off: no motion-level crossfade, it would show both arm sets half transparent
            c.update(FadeInTime=0.0, FadeOutTime=0.0)
        out.append(c)
        segs += len(keys) - 1; pts += len(keys)
    return {'Version': 3, 'Meta': {'Duration': DURATION, 'Fps': 30.0, 'Loop': False, 'AreBeziersRestricted': True,
                                   'CurveCount': len(out), 'TotalSegmentCount': segs, 'TotalPointCount': pts,
                                   'UserDataCount': 0, 'TotalUserDataSize': 0}, 'Curves': out}

def seg_count(s):
    """(segments, points) in a motion3 segment array; bezier segments carry 3 points, the rest 1"""
    i, n, pts = 2, 0, 1
    while i < len(s):
        bez = s[i] == 1
        i += 7 if bez else 3
        n += 1; pts += 3 if bez else 1
    return n, pts

def main(src, dst):
    for ext in ('moc3', 'cdi3.json', 'physics3.json'):
        shutil.copyfile(os.path.join(src, f'nova_chibi.{ext}'), os.path.join(dst, f'NovaChibi.{ext}'))
    shutil.copyfile(os.path.join(src, 'nova_chibi.2048', 'texture_00.png'), os.path.join(dst, 'NovaChibi.2048', 'texture_00.png'))
    params = {p['Id'] for p in json.load(open(os.path.join(src, 'nova_chibi.cdi3.json'), encoding='utf-8'))['Parameters']}
    os.makedirs(os.path.join(dst, 'expressions'), exist_ok=True)
    for name, ps in EXPRESSIONS.items():
        ps = dict(ps, **({'ParamExpNeutralHide': 1} if ps else {}))
        assert set(ps) <= params, set(ps) - params
        dump(os.path.join(dst, 'expressions', f'{name}.exp3.json'), {
            'Type': 'Live2D Expression', 'FadeInTime': 0.25, 'FadeOutTime': 0.25,
            'Parameters': [{'Id': k, 'Value': v, 'Blend': 'Overwrite'} for k, v in ps.items()]})
    for name, (toggle, head) in GESTURES.items():
        assert toggle in params and all(p in params for p, _ in head)
        # gesture arms swap in at once and back out at 2.1 s, before the 0.3 s fade-out; the SDK keeps the last value
        # a motion wrote (saveParameters runs after motions), so every other gesture toggle is pinned to 0 as well
        ramp = [(0, 1), (2.1, 0, 'step'), (DURATION, 0)]
        others = [(t, [(0, 0), (DURATION, 0)], 'cut') for t, _ in GESTURES.values() if t != toggle]
        dump(os.path.join(dst, f'NovaChibi.{name.lower()}.motion3.json'),
             motion([(toggle, ramp, 'cut'), ('ParamArmsDefault', ramp, 'cut')] + others + head))
    # Codex's idle/nod/shake don't know the gesture toggles; pin them to 0 so an interrupted gesture can't stick
    rest = [(t, [(0, 0), (1, 0)]) for t, _ in GESTURES.values()] + [('ParamArmsDefault', [(0, 0), (1, 0)])]
    for n in ('idle', 'nod', 'shake'):
        fp = os.path.join(dst, f'NovaChibi.{n}.motion3.json')
        m = json.load(open(fp, encoding='utf-8'))
        dur = m['Meta']['Duration']
        keep = [c for c in m['Curves'] if c['Id'] not in {i for i, _ in rest}]
        add = motion([(i, [(0, 0), (dur, 0)], 'cut') for i, _ in rest])['Curves']
        m['Curves'] = keep + add
        m['Meta']['CurveCount'] = len(m['Curves'])
        m['Meta']['TotalSegmentCount'] = sum(seg_count(c['Segments'])[0] for c in m['Curves'])
        m['Meta']['TotalPointCount'] = sum(seg_count(c['Segments'])[1] for c in m['Curves'])
        dump(fp, m)
    m3 = json.load(open(os.path.join(dst, 'NovaChibi.model3.json'), encoding='utf-8'))
    refs = m3['FileReferences']
    for name in GESTURES:
        refs['Motions'][name] = [{'File': f'NovaChibi.{name.lower()}.motion3.json', 'FadeInTime': 0.2, 'FadeOutTime': 0.3}]
    refs['Expressions'] = [{'Name': n, 'File': f'expressions/{n}.exp3.json'} for n in EXPRESSIONS]
    dump(os.path.join(dst, 'NovaChibi.model3.json'), m3)
    groups = set(refs['Motions'])
    assert set(DESKPET['expressions'].values()) <= set(EXPRESSIONS) and set(DESKPET['motions'].values()) <= groups
    dump(os.path.join(dst, 'deskpet.json'), DESKPET)
    print('expressions', len(EXPRESSIONS), 'motions', sorted(groups))

if __name__ == '__main__':
    main(*sys.argv[1:3])
