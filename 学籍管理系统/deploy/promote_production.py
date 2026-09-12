from pathlib import Path
import os

path = Path('/opt/student-check/.env')
if not path.is_file():
    raise SystemExit('Missing application environment file.')
replacements = {
    'DEMO_MODE': '0',
    'HTTPS_ENABLED': '1',
    'PUBLIC_URL': 'https://47.99.222.76/xueji/',
    'ALLOWED_HOSTS': '47.99.222.76,127.0.0.1,localhost,testserver',
}
lines = []
seen = set()
for line in path.read_text().splitlines():
    key = line.split('=', 1)[0]
    if key in replacements:
        lines.append(key + '=' + replacements[key])
        seen.add(key)
    else:
        lines.append(line)
for key, value in replacements.items():
    if key not in seen:
        lines.append(key + '=' + value)
path.write_text('\n'.join(lines) + '\n')
os.chmod(path, 0o600)
print('Production HTTPS settings enabled; secrets unchanged and hidden.')
