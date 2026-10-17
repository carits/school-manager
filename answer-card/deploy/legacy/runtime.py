"""Recreate only the independent legacy runtime; production is never restarted."""
import pathlib, subprocess, json
ROOT=pathlib.Path('/home/ecs-user/school-manager-answer-card/answer-card')
STATE=ROOT/'deploy/legacy'
def run(*args): return subprocess.run(args,check=True,stdout=subprocess.PIPE,text=True).stdout.strip()
def start(image='school-manager-legacy:pdf-v1'):
 if not (STATE/'legacy.env').exists(): raise RuntimeError('Independent credentials missing')
 config=dict(x.split('=',1) for x in (STATE/'legacy.env').read_text().splitlines() if '=' in x)
 if config.get('PROJECTX_MARIADB_HOST')!='legacy-old-db' or config.get('PROJECTX_MARIADB_DATABASE')!='school_manager_legacy': raise RuntimeError('Refusing protected database')
 names=run('docker','ps','-a','--format','{{.Names}}').splitlines()
 if 'legacy-old-app' in names:
  current=json.loads(run('docker','inspect','legacy-old-app'))[0]
  if any(m.get('Name','').startswith('answer-card_') for m in current['Mounts']):raise RuntimeError('Protected volume found')
  run('docker','stop','legacy-old-app');run('docker','rm','legacy-old-app')
 run('docker','create','--name','legacy-old-app','--init','--network','legacy-old-web','--cpus','0.8','--memory','1088m','--pids-limit','192','--ulimit','core=0','--restart','unless-stopped','--log-opt','max-size=10m','--log-opt','max-file=3','--env-file',str(STATE/'legacy.env'),'-p','127.0.0.1:5180:5174','-v',str(STATE/'data')+':/app/data/answer-card','-v',str(STATE/'guard')+':/guard:ro',image)
 run('docker','network','connect','legacy-old','legacy-old-app')
 run('docker','update','--cpus','.15','--memory','384m','legacy-old-db')
 run('docker','start','legacy-old-app')
if __name__=='__main__':start()
