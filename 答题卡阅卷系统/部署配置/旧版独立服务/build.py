"""Build this checkout in a limited container; package existing native tools."""
import pathlib, subprocess, json, time, importlib.util
SOURCE=pathlib.Path(__file__).resolve().parents[2]
STATE=pathlib.Path('/home/ecs-user/school-manager-answer-card/answer-card/部署配置/旧版独立服务')
DEPS=STATE.parents[1]/'node_modules'
def run(*a):return subprocess.run(a,check=True,stdout=subprocess.PIPE,text=True).stdout.strip()
def healthy():
 h=json.loads((STATE/'guard/health.json').read_text())
 if h.get('paused') or time.time()*1000-h['time']>90000:raise RuntimeError('Build stopped by resource guard')
healthy()
if 'legacy-old-app' in run('docker','ps','--format','{{.Names}}').splitlines():run('docker','stop','legacy-old-app')
with (STATE/'build-final.log').open('w') as log:
 process=subprocess.Popen(['docker','run','--rm','--name','legacy-build-web','--cpus','.8','--memory','1024m','--ulimit','core=0','-e','NODE_OPTIONS=--max-old-space-size=832','-e','VITE_LEGACY_ONLY=1','-v',str(SOURCE)+':/work','-v',str(DEPS)+':/work/node_modules:ro','--tmpfs','/work/node_modules/.vite-temp:rw,size=16m','-w','/work','node:22-bookworm','sh','-c','npm run typecheck && npm run build:web && npm run build:server'],stdout=log,stderr=subprocess.STDOUT)
 try:
  while process.poll() is None: healthy();time.sleep(5)
 except Exception:
  run('docker','stop','legacy-build-web');raise
 if process.returncode:raise RuntimeError('Build failed; see build-final.log')
if 'legacy-package' in run('docker','ps','-a','--format','{{.Names}}').splitlines():run('docker','rm','legacy-package')
run('docker','create','--name','legacy-package','school-manager-legacy:tools')
run('docker','cp',str(SOURCE/'dist')+'/.','legacy-package:/app/dist/')
run('docker','cp',str(SOURCE/'源码/server/services/legacy-pdf-worker.py'),'legacy-package:/app/运行资源/legacy-worker.py')
run('docker','cp',str(SOURCE/'部署配置/旧版独立服务/schema.sql'),'legacy-package:/app/运行资源/legacy-schema.sql')
image=run('docker','commit','--change','ENTRYPOINT ["node"]','--change','CMD ["dist/server/index.mjs"]','--change','USER 10001:10001','legacy-package','school-manager-legacy:pdf-v1')
(STATE/'legacy-image.id').write_text(image)
print(image)
