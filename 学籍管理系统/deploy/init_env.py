import os
import secrets
import base64
from pathlib import Path
p=Path('/opt/student-check/.env')
if p.exists():
    print('Environment exists; kept unchanged.')
else:
    values={'SECRET_KEY':secrets.token_urlsafe(48),'DATA_KEY':base64.urlsafe_b64encode(os.urandom(32)).decode(),
            'LOOKUP_KEY':secrets.token_urlsafe(48),'DB_PASSWORD':secrets.token_urlsafe(36),
            'DEMO_MODE':'1','HTTPS_ENABLED':'0','PUBLIC_URL':'http://47.99.222.76/xueji/',
            'ALLOWED_HOSTS':'47.99.222.76,127.0.0.1,localhost,testserver'}
    fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:f.write(''.join(k+'='+v+'\n' for k,v in values.items()))
    print('Independent environment generated; values hidden.')
