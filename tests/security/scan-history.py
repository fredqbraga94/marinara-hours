"""Signature scan of reachable git blobs; output never includes matched values."""
import base64
import json
import re
import subprocess

patterns = {
    'privileged-jwt': re.compile(rb'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}'),
    'secret-token': re.compile(rb'(?:sb_secret_|gh[pousr]_|github_pat_|sk-proj-|sk_live_)[A-Za-z0-9_-]{16,}'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
hits = []
scanned = 0
objects = subprocess.run(['git', 'rev-list', '--objects', '--all'], check=True, capture_output=True, text=True)
for line in objects.stdout.splitlines():
    oid, _, path = line.partition(' ')
    if not path:
        continue
    blob = subprocess.run(['git', 'cat-file', 'blob', oid], capture_output=True)
    if blob.returncode:
        continue
    scanned += 1
    for kind, pattern in patterns.items():
        for match in pattern.finditer(blob.stdout):
            if kind == 'privileged-jwt':
                try:
                    role = json.loads(base64.urlsafe_b64decode(match[0].split(b'.')[1] + b'===')).get('role')
                except (ValueError, TypeError):
                    continue
                if role != 'service_role':
                    continue
            hits.append({'object': oid, 'path': path, 'kind': kind})
print(json.dumps({'reachable_blobs_scanned': scanned, 'findings': hits}, indent=2))
raise SystemExit(1 if hits else 0)
