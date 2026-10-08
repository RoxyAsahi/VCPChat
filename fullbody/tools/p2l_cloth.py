"""Drive a running PSD2Live GUI over MCP: import PSD -> atlas 2048 -> presets -> export.

usage: python p2l_cloth.py <psd> <out_dir> <preset> [<preset> ...]
presets: clothing, back_hair, front_hair (model_apply_preset values)
"""
import json, os, sys, time, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2l_mcp import Client

def rid(tag): return f'{tag}-{uuid.uuid4().hex[:10]}'

def main(psd, out_dir, presets):
    c = Client()
    names = {t['name'] for t in c.call_raw_list()} if hasattr(c, 'call_raw_list') else None
    ins = c.call('workspace_inspect', {'scope': 'project'})['data']
    job = c.call('project_import_psd', {'path': os.path.abspath(psd), 'discard_unsaved': True,
                                        'request_id': rid('imp'), 'project_id': ins.get('project_id'),
                                        'state': ins['state']})
    if not job.get('ok', True): raise SystemExit(json.dumps(job, ensure_ascii=False))
    d = c.wait(job)
    if d['status'] != 'completed': raise SystemExit(json.dumps(d, ensure_ascii=False)[:3000])
    pid, state = d['result']['project_id'], d['result']['state']
    st = c.call('workspace_inspect', {'scope': 'settings'})['data']
    print('settings', json.dumps(st.get('settings'), ensure_ascii=False)[:800])
    if st.get('settings', {}).get('atlasSize') != 2048:
        job = c.call('settings_update', {'request_id': rid('set'), 'project_id': pid, 'state': state,
                                         'changes': {'atlasSize': 2048}})
        if not job.get('ok', True): print('settings_update refused', json.dumps(job, ensure_ascii=False)[:1500])
        else:
            d = c.wait(job); print('settings_update', d['status'], json.dumps(d.get('error'), ensure_ascii=False)[:800])
            if d['status'] == 'completed': state = d['result']['state']
    report = {}
    for p in presets:
        job = c.call('model_apply_preset', {'preset': p, 'request_id': rid(p), 'project_id': pid, 'state': state})
        if not job.get('ok', True):
            print(p, 'refused', json.dumps(job, ensure_ascii=False)[:2000]); continue
        d = c.wait(job)
        print('preset', p, d['status'])
        if d['status'] == 'completed':
            state = d['result']['state']; report[p] = d['result']
            print(json.dumps(d['result'], ensure_ascii=False)[:6000])
        else:
            print(json.dumps(d.get('error'), ensure_ascii=False)[:3000])
    phys = c.call('workspace_inspect', {'scope': 'physics'})['data']
    sims = c.call('workspace_inspect', {'scope': 'simulations'})['data']
    os.makedirs(out_dir, exist_ok=True)
    job = c.call('project_export_model', {'request_id': rid('exp'), 'project_id': pid, 'state': state,
                                          'output_directory': os.path.abspath(out_dir)})
    d = c.wait(job)
    print('export', d['status'], json.dumps(d.get('result') or d.get('error'), ensure_ascii=False)[:3000])
    with open(os.path.join(out_dir, '_mcp_report.json'), 'w', encoding='utf-8') as fp:
        json.dump({'presets': report, 'physics': phys, 'simulations': sims, 'export': d}, fp, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3:])

