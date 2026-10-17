"""Switch old pages only, or roll them back; leave review container and DB untouched."""
import pathlib,subprocess,hashlib,json,urllib.request,urllib.error,sys
STATE=pathlib.Path('/home/ecs-user/school-manager-answer-card/answer-card/部署配置/旧版独立服务')
CONFIG=pathlib.Path('/etc/nginx/sites-enabled/carits-answer-card.conf')
def run(*a):return subprocess.run(a,check=True,stdout=subprocess.PIPE,text=True).stdout
def sha(b):return hashlib.sha256(b).hexdigest()
def write(b):
 tmp=STATE/'nginx.candidate';tmp.write_bytes(b)
 run('sudo','cp',str(tmp),str(CONFIG))
def main():
 old=CONFIG.read_bytes()
 if '--rollback' in sys.argv:
  record=json.loads((STATE/'switch.json').read_text())
  if sha(old)!=record['after_hash']:raise RuntimeError('Nginx changed after switch; refusing overwrite')
  write((STATE/'nginx.switch.before').read_bytes())
  run('sudo','nginx','-t');run('sudo','systemctl','reload','nginx');print('Old route restored; protected container untouched');return
 if '--switch' not in sys.argv:raise RuntimeError('Use --switch after deployment coordination')
 response=urllib.request.urlopen('http://127.0.0.1:5180/api/app/health',timeout=5)
 if response.status!=200:raise RuntimeError('Old runtime unavailable')
 if b'location ^~ /answer-card/legacy-api/' in old:raise RuntimeError('Already switched')
 text=old.decode();needle='location /answer-card/ {'
 if text.count(needle)!=1:raise RuntimeError('Unexpected route configuration')
 block_start=text.index(needle);block_end=text.index('}',block_start)
 old_block=text[block_start:block_end]
 if 'http://127.0.0.1:5176/' not in old_block:raise RuntimeError('Unexpected original upstream')
 new_block=old_block.replace('http://127.0.0.1:5176/','http://127.0.0.1:5180/')
 pins='''    location = /answer-card/review { proxy_pass http://127.0.0.1:5176/review; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
    location ^~ /answer-card/review/ { proxy_pass http://127.0.0.1:5176/review/; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
    location = /answer-card/favicon.svg { proxy_pass http://127.0.0.1:5176/favicon.svg; }
    location = /answer-card/favicon-32.png { proxy_pass http://127.0.0.1:5176/favicon-32.png; }
    location = /answer-card/favicon.ico { proxy_pass http://127.0.0.1:5176/favicon.ico; }
    location = /answer-card/apple-touch-icon.png { proxy_pass http://127.0.0.1:5176/apple-touch-icon.png; }
    location ^~ /answer-card/legacy-assets/ { proxy_pass http://127.0.0.1:5176/legacy-assets/; proxy_set_header Host $host; }
    location ^~ /answer-card/assets/ { proxy_pass http://127.0.0.1:5176/assets/; proxy_set_header Host $host; }
    location ^~ /answer-card/legacy-api/ {
        proxy_pass http://127.0.0.1:5180/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
'''
 candidate=(text[:block_start]+pins+new_block+text[block_end:]).encode()
 baseline={}
 for path in ['/answer-card/review/','/answer-card/api/auth/me','/answer-card/api/review-tasks']:
  try:r=urllib.request.urlopen('https://carits.top'+path,timeout=10);body=r.read();status=r.status
  except urllib.error.HTTPError as e:body=e.read();status=e.code
  baseline[path]={'status':status,'hash':sha(body)}
 (STATE/'nginx.switch.before').write_bytes(old);(STATE/'switch-protected-before.json').write_text(json.dumps(baseline))
 try:
  write(candidate);run('sudo','nginx','-t');run('sudo','systemctl','reload','nginx')
 except Exception:
  write(old);run('sudo','nginx','-t');run('sudo','systemctl','reload','nginx');raise
 (STATE/'switch.json').write_text(json.dumps({'before_hash':sha(old),'after_hash':sha(candidate)}))
 print('Old pages switched. Review/API/assets remain original.')
if __name__=='__main__':main()
