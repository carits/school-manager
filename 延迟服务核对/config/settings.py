import os
from pathlib import Path
BASE_DIR=Path(__file__).resolve().parent.parent
SECRET_KEY=os.environ.get('SECRET_KEY','change-me'); DEBUG=False
ALLOWED_HOSTS=os.environ.get('ALLOWED_HOSTS','127.0.0.1,localhost').split(',')
PUBLIC_URL=os.environ.get('PUBLIC_URL','https://carits.top/yanchi/').rstrip('/')+'/'
HTTPS_ENABLED=os.environ.get('HTTPS_ENABLED','1')=='1'
DATA_KEY=os.environ.get('DATA_KEY','change-data-key'); LOOKUP_KEY=os.environ.get('LOOKUP_KEY','change-lookup-key')
INSTALLED_APPS=['django.contrib.admin','django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','django.contrib.messages','django.contrib.staticfiles','delaycheck']
MIDDLEWARE=['django.middleware.security.SecurityMiddleware','whitenoise.middleware.WhiteNoiseMiddleware','django.contrib.sessions.middleware.SessionMiddleware','django.middleware.common.CommonMiddleware','django.middleware.csrf.CsrfViewMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware','django.contrib.messages.middleware.MessageMiddleware','django.middleware.clickjacking.XFrameOptionsMiddleware']
ROOT_URLCONF='config.urls'; WSGI_APPLICATION='config.wsgi.application'
TEMPLATES=[{'BACKEND':'django.template.backends.django.DjangoTemplates','DIRS':[BASE_DIR/'templates'],'APP_DIRS':True,'OPTIONS':{'context_processors':['django.template.context_processors.request','django.contrib.auth.context_processors.auth','django.contrib.messages.context_processors.messages']}}]
if os.environ.get('DB_HOST'):
 DATABASES={'default':{'ENGINE':'django.db.backends.postgresql','NAME':os.environ.get('DB_NAME','yanchi'),'USER':os.environ.get('DB_USER','yanchi'),'PASSWORD':os.environ.get('DB_PASSWORD',''),'HOST':os.environ['DB_HOST'],'PORT':'5432','CONN_MAX_AGE':60}}
else: DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':BASE_DIR/'local.sqlite3'}}
LANGUAGE_CODE='zh-hans'; TIME_ZONE='Asia/Shanghai'; USE_I18N=True; USE_TZ=True
STATIC_URL='/yanchi/static/'; STATIC_ROOT=BASE_DIR/'staticfiles'; STATICFILES_DIRS=[BASE_DIR/'static']
STORAGES={'default':{'BACKEND':'django.core.files.storage.FileSystemStorage'},'staticfiles':{'BACKEND':'whitenoise.storage.CompressedManifestStaticFilesStorage'}}
DEFAULT_AUTO_FIELD='django.db.models.BigAutoField'; SESSION_COOKIE_NAME='yanchi_session'; CSRF_COOKIE_NAME='yanchi_csrf'; SESSION_COOKIE_PATH=CSRF_COOKIE_PATH='/yanchi/'; SESSION_COOKIE_AGE=1800; SESSION_COOKIE_HTTPONLY=True; SESSION_COOKIE_SAMESITE='Lax'; SESSION_COOKIE_SECURE=HTTPS_ENABLED; CSRF_COOKIE_SECURE=HTTPS_ENABLED; SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https'); SECURE_SSL_REDIRECT=False; X_FRAME_OPTIONS='DENY'; SECURE_CONTENT_TYPE_NOSNIFF=True; SECURE_REFERRER_POLICY='same-origin'; DATA_UPLOAD_MAX_MEMORY_SIZE=2*1024*1024
