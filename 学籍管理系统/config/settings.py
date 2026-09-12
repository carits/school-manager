import json
import os
from pathlib import Path
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
local = BASE_DIR / 'local-secrets.json'
secrets = json.loads(local.read_text()) if local.exists() else {}
def env(key, default=None):
    return os.environ.get(key, secrets.get(key, default))

SECRET_KEY = env('SECRET_KEY')
DATA_KEY = env('DATA_KEY')
LOOKUP_KEY = env('LOOKUP_KEY')
if not all((SECRET_KEY, DATA_KEY, LOOKUP_KEY)):
    raise ImproperlyConfigured('Run scripts/init_local.py or configure SECRET_KEY, DATA_KEY and LOOKUP_KEY.')
DEBUG = False
DEMO_MODE = env('DEMO_MODE', '1') == '1'
PUBLIC_URL = env('PUBLIC_URL', 'http://127.0.0.1:8091/xueji/').rstrip('/') + '/'
HTTPS_ENABLED = env('HTTPS_ENABLED', '0') == '1'
if not DEMO_MODE and (not HTTPS_ENABLED or not PUBLIC_URL.startswith('https://')):
    raise ImproperlyConfigured('Real data requires HTTPS_ENABLED=1 and an HTTPS PUBLIC_URL.')
ALLOWED_HOSTS = env('ALLOWED_HOSTS', '127.0.0.1,localhost,testserver').split(',')
CSRF_TRUSTED_ORIGINS = [PUBLIC_URL.split('/xueji')[0]]
INSTALLED_APPS = ['django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
                  'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles', 'checks']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'whitenoise.middleware.WhiteNoiseMiddleware',
              'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware',
              'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware',
              'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware',
              'checks.middleware.PrivateMiddleware']
ROOT_URLCONF = 'config.urls'
TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'DIRS': [BASE_DIR / 'templates'],
              'APP_DIRS': True, 'OPTIONS': {'context_processors': ['django.template.context_processors.request',
              'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages',
              'checks.views.common_context']}}]
WSGI_APPLICATION = 'config.wsgi.application'
if env('DB_HOST'):
    DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': env('DB_NAME', 'student_check'),
                 'USER': env('DB_USER', 'student_check'), 'PASSWORD': env('DB_PASSWORD'),
                 'HOST': env('DB_HOST'), 'PORT': '5432', 'CONN_MAX_AGE': 60}}
else:
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'local.sqlite3', 'OPTIONS': {'timeout': 20}}}
AUTH_PASSWORD_VALIDATORS = [{'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
                            {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'}]
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'Asia/Shanghai'
USE_I18N = True
USE_TZ = True
STATIC_URL = '/xueji/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STATICFILES_DIRS = [BASE_DIR / 'static']
STORAGES = {'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
            'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'}}
SESSION_COOKIE_NAME = 'xueji_session'
CSRF_COOKIE_NAME = 'xueji_csrf'
SESSION_COOKIE_PATH = CSRF_COOKIE_PATH = '/xueji/'
SESSION_COOKIE_AGE = 1800
SESSION_SAVE_EVERY_REQUEST = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = HTTPS_ENABLED
SECURE_SSL_REDIRECT = HTTPS_ENABLED
SECURE_REDIRECT_EXEMPT = [r'^xueji/health/$']
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_HSTS_SECONDS = 31536000 if HTTPS_ENABLED else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
# Subdomain HSTS and preload remain disabled so deployment policy can be chosen separately.
SILENCED_SYSTEM_CHECKS = ['security.W005', 'security.W021'] if HTTPS_ENABLED else []
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'same-origin'
X_FRAME_OPTIONS = 'DENY'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
DATA_UPLOAD_MAX_MEMORY_SIZE = 12 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 12 * 1024 * 1024
LOGIN_URL = '/xueji/admin/login/'
LOGGING = {'version': 1, 'disable_existing_loggers': False,
           'handlers': {'console': {'class': 'logging.StreamHandler'}},
           'loggers': {'django.request': {'handlers': ['console'], 'level': 'ERROR', 'propagate': False}}}
