import json
import secrets
from pathlib import Path
from cryptography.fernet import Fernet
path = Path(__file__).resolve().parents[1] / 'local-secrets.json'
if not path.exists():
    path.write_text(json.dumps({'SECRET_KEY': secrets.token_urlsafe(48), 'DATA_KEY': Fernet.generate_key().decode(),
                                'LOOKUP_KEY': secrets.token_urlsafe(48)}))
print('Local secrets ready (values hidden).')
