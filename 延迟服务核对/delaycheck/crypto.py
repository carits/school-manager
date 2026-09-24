import base64,hashlib,hmac,json
from cryptography.fernet import Fernet
from django.conf import settings
def _fernet():
 key=base64.urlsafe_b64encode(hashlib.sha256(settings.DATA_KEY.encode()).digest()); return Fernet(key)
def encrypt(value): return _fernet().encrypt(json.dumps(value,ensure_ascii=False).encode()).decode()
def decrypt(value): return json.loads(_fernet().decrypt(value.encode()).decode()) if value else {}
def lookup(value): return hmac.new(settings.LOOKUP_KEY.encode(),value.strip().upper().encode(),hashlib.sha256).hexdigest()
