from pathlib import Path
import shutil
import subprocess
import time
config=Path('/etc/nginx/sites-enabled/oi-manager').resolve()
if not str(config).startswith('/etc/nginx/'):raise SystemExit('Unexpected nginx config path')
original=config.read_text()
snippet=Path('/opt/student-check/deploy/nginx-location.conf').read_text()
if 'location ^~ /xueji/' in original:
    print('Nginx route already installed.');raise SystemExit(0)
if original.count('    listen 80;')!=1:raise SystemExit('Unexpected server block; review required')
backup=Path('/opt/student-check/backups')/('nginx-before-'+str(int(time.time()))+'.conf')
shutil.copy2(config,backup)
config.write_text(original.replace('    listen 80;','    listen 80;\n'+snippet,1))
try:
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
except Exception:
    shutil.copy2(backup,config)
    subprocess.run(['nginx','-t'],check=True)
    subprocess.run(['systemctl','reload','nginx'],check=True)
    subprocess.run(['/opt/student-check/bin/docker-compose','-f','/opt/student-check/compose.yml','stop','web'],cwd='/opt/student-check')
    raise
print('Nginx route installed; previous routes preserved.')
