"""Verify and decode a mouth-evidence result.json and its geometry archive."""
from pathlib import Path
import sys,json,gzip,hashlib
def read_evidence(path):
    path=Path(path)
    metadata=json.loads(path.read_text(encoding='utf-8'))
    spec=metadata['geometry_archive']
    raw=gzip.decompress((path.parent/spec['file']).read_bytes())
    sha=lambda data:hashlib.sha256(data).hexdigest()
    assert sha(raw)==spec['uncompressed_sha256']
    data=json.loads(raw)
    if spec.get('encoding')=='array-table-v1':
        assert data['encoding']=='array-table-v1'
        def expand(value):
            if isinstance(value,dict):
                if set(value)=={'$array'}:return data['arrays'][value['$array']]
                return {k:expand(v) for k,v in value.items()}
            if isinstance(value,list):return [expand(v) for v in value]
            return value
        decoded=expand(data['data'])
        assert sha(json.dumps(decoded,separators=(',',':')).encode())==spec['decoded_uncompressed_sha256']
        return decoded
    return data
if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Usage: python -I read_mouth_evidence.py <result.json>')
    decoded=read_evidence(sys.argv[1])
    print(json.dumps({'verified':True,'fields':list(decoded),'pose_counts':{k:len(v) for k,v in decoded.items()}}))
