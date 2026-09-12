from pathlib import Path
import shutil
import subprocess
import time

ip = '47.99.222.76'
config = Path('/etc/nginx/sites-enabled/oi-manager').resolve()
if not str(config).startswith('/etc/nginx/'):
    raise SystemExit('Unexpected nginx config path.')
original = config.read_text()
backup = Path('/opt/student-check/backups') / ('nginx-before-ip-https-' + str(int(time.time())) + '.conf')
shutil.copy2(config, backup)
Path('/var/www/letsencrypt').mkdir(parents=True, exist_ok=True)

challenge = '''
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }
'''
working = original
if 'location ^~ /.well-known/acme-challenge/' not in working:
    working = working.replace('    listen 80;', '    listen 80;\n' + challenge, 1)
    config.write_text(working)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)

certbot = [
    'docker', 'run', '--rm',
    '-v', '/etc/letsencrypt:/etc/letsencrypt',
    '-v', '/var/lib/letsencrypt:/var/lib/letsencrypt',
    '-v', '/var/log/letsencrypt:/var/log/letsencrypt',
    '-v', '/var/www/letsencrypt:/var/www/letsencrypt',
    'certbot/certbot:v5.4.0', 'certonly', '--webroot',
    '--webroot-path', '/var/www/letsencrypt',
    '--preferred-profile', 'shortlived', '--ip-address', ip,
    '--non-interactive', '--agree-tos', '--register-unsafely-without-email',
    '--keep-until-expiring',
]
subprocess.run(certbot, check=True)

working = config.read_text()
if 'listen 443 ssl;' not in working:
    tls = f'''    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/{ip}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{ip}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:student_check_tls:10m;
    ssl_session_timeout 1d;
'''
    working = working.replace('    listen 80;', '    listen 80;\n' + tls, 1)
if 'if ($scheme = http)' not in working:
    working = working.replace(
        '    location = /xueji { return 302 /xueji/; }',
        f'    location = /xueji {{ return 301 https://{ip}/xueji/; }}',
        1,
    )
    working = working.replace(
        '    location ^~ /xueji/ {',
        '    location ^~ /xueji/ {\n        if ($scheme = http) { return 301 https://$host$request_uri; }',
        1,
    )
config.write_text(working)
try:
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    shutil.copy2(backup, config)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print('Trusted IP HTTPS enabled; certificate values hidden.')
