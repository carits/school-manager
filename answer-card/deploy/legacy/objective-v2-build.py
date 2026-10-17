import pathlib,subprocess,json,time,importlib.util,os
work=pathlib.Path('/home/ecs-user/school-manager-answer-card-legacy-preview/answer-card')
state=pathlib.Path('/home/ecs-user/school-manager-answer-card/answer-card/deploy/legacy')
def run(*args):return subprocess.check_output(args,text=True).strip()
def healthy():
 h=json.loads((state/'guard/health.json').read_text())
 if h.get('paused') or time.time()*1000-h['time']>90000:raise RuntimeError('Resource guard stopped build')
healthy();old=json.loads((state/'objective-v2-runtime-before.json').read_text())['legacy-old-app']['image']
run('docker','stop','legacy-old-app')
try:
 with (state/'objective-v2-build.log').open('w') as log:
  proc=subprocess.Popen(['docker','run','--rm','--name','legacy-objective-v2-build','--cpus','.8','--memory','1024m','--ulimit','core=0','-e','NODE_OPTIONS=--max-old-space-size=832','-e','VITE_LEGACY_ONLY=1','-v',str(work)+':/work','-v',str(state.parents[1]/'node_modules')+':/work/node_modules:ro','--tmpfs','/work/node_modules/.vite-temp:rw,size=16m','-w','/work','node:22-bookworm','sh','-c',('./node_modules/.bin/tsx deploy/legacy/paper-confirm-test.ts && ./node_modules/.bin/tsx deploy/legacy/generation-readiness-test.ts && npm run typecheck && '+('' if os.environ.get('LEGACY_SERVER_ONLY_BUILD')=='1' else 'npm run build:web && ')+'npm run build:server')],stdout=log,stderr=subprocess.STDOUT)
  try:
   while proc.poll() is None:healthy();time.sleep(5)
  except Exception:run('docker','stop','legacy-objective-v2-build');raise
  if proc.returncode:raise RuntimeError('Build failed')
 run('docker','create','--name','legacy-objective-v2-package',old)
 for part in ['web','server']:run('docker','cp',str(work/'dist'/part)+'/.','legacy-objective-v2-package:/app/dist/'+part+'/')
 run('docker','cp',str(work/'src/server/services/legacy-pdf-worker.py'),'legacy-objective-v2-package:/app/resources/legacy-worker.py')
 run('docker','cp',str(work/'deploy/legacy/schema.sql'),'legacy-objective-v2-package:/app/resources/legacy-schema.sql')
 image=run('docker','commit','legacy-objective-v2-package','school-manager-legacy:objective-v2');run('docker','rm','legacy-objective-v2-package')
 (state/'legacy-image.id').write_text(image);print(image,flush=True)
 spec=importlib.util.spec_from_file_location('legacy_runtime',work/'deploy/legacy/runtime.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);mod.start(image)
except Exception:
 run('docker','start','legacy-old-app');raise
