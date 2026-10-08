"""Tiny Streamable-HTTP MCP client for a running PSD2Live GUI (token read from its Java prefs).

usage: python p2l_mcp.py <tool> '<json args>'      -> prints the tool result JSON
"""
import json, sys, urllib.request, importlib.util, os

spec = importlib.util.spec_from_file_location(
    'mcp_proxy', os.path.join(os.path.dirname(__file__), '..', '..', 'psd2live', 'mcp_proxy.py'))
proxy = importlib.util.module_from_spec(spec); spec.loader.exec_module(proxy)
TOKEN, ENDPOINT = proxy.get_token(), proxy.get_endpoint()

def _post(body, sid=None):
    h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
         'Authorization': f'Bearer {TOKEN}'}
    if sid: h['Mcp-Session-Id'] = sid
    req = urllib.request.Request(ENDPOINT, json.dumps(body).encode(), h)
    with urllib.request.urlopen(req, timeout=600) as r:
        sid = r.headers.get('Mcp-Session-Id') or sid
        raw = r.read().decode('utf-8')
    if raw.lstrip().startswith('{'):
        return json.loads(raw), sid
    msgs = [json.loads(l[5:]) for l in raw.splitlines() if l.startswith('data:')]
    return (msgs[-1] if msgs else None), sid

class Client:
    def __init__(self):
        r, self.sid = _post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'nova-fullbody', 'version': '1'}}})
        _post({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, self.sid)
        self.n = 1

    def call(self, op, req):
        if op.startswith('job_'):
            return self.tool('job', {'op': op[4:], 'request': req})
        if op in ('workspace_inspect', 'workspace_get_operation', 'workspace_overview'):
            return self.tool(op, {'request': req})
        return self.tool('workspace_call', {'operation': op, 'request': req})

    def tool(self, tool, args):
        self.n += 1
        r, _ = _post({'jsonrpc': '2.0', 'id': self.n, 'method': 'tools/call',
                      'params': {'name': tool, 'arguments': args}}, self.sid)
        if 'error' in r:
            raise RuntimeError(json.dumps(r['error'], ensure_ascii=False))
        res = r['result']
        if res.get('structuredContent') is not None:
            return res['structuredContent']
        texts = [c['text'] for c in res.get('content', []) if c.get('type') == 'text']
        try:
            return json.loads(texts[0])
        except Exception:
            return {'text': texts, 'isError': res.get('isError')}

    def wait(self, handle, timeout_ms=30000):
        data = handle.get('data', handle)
        while data.get('status') not in ('completed', 'failed', 'cancelled'):
            data = self.call('job_wait', {'id': data['id'], 'timeout_ms': timeout_ms}).get('data')
        return data

if __name__ == '__main__':
    c = Client()
    print(json.dumps(c.tool(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}),
                     ensure_ascii=False, indent=1)[:20000])

