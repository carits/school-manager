import hashlib
import hmac
import json
import unicodedata
from cryptography.fernet import Fernet
from django.conf import settings

def encrypt(value):
    return Fernet(settings.DATA_KEY.encode()).encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()

def decrypt(value):
    return json.loads(Fernet(settings.DATA_KEY.encode()).decrypt(value.encode())) if value else {}

def normalize(value):
    return unicodedata.normalize('NFKC', str(value)).strip()

def digest(value):
    return hmac.new(settings.LOOKUP_KEY.encode(), value.encode(), hashlib.sha256).hexdigest()

def identity(name, number):
    return digest(normalize(name) + '\x00' + normalize(number).upper())
