import json,time,urllib.request,urllib.error,os,shutil
from pathlib import Path
root=Path(__file__).parent
baseline=json.loads((root/"protected-baseline.json").read_text())
directory=root/"guard";directory.mkdir(exist_ok=True);os.chmod(directory,0o755)
slow=0
while True:
 status={"time":time.time()*1000,"paused":False,"reason":None}
 try:
  mem=Path("/proc/meminfo").read_text()
  available=int(next(x for x in mem.splitlines() if x.startswith("MemAvailable:")).split()[1])*1024
  if available<800*1024**2:raise RuntimeError("资源保护暂停：可用内存不足800MiB")
  if shutil.disk_usage(root).free<8*1024**3:raise RuntimeError("资源保护暂停：磁盘余量不足8GiB")
  start=time.monotonic()
  with urllib.request.urlopen("https://carits.top/answer-card/review/",timeout=5) as r:
   if r.status>=500:raise RuntimeError("资源保护暂停：现有阅卷出现5xx")
   r.read()
  elapsed=time.monotonic()-start;status["review_ms"]=round(elapsed*1000,1)
  threshold=max(.5,2*baseline["http"][0]["seconds"])
  slow=slow+1 if elapsed>threshold else 0
  if slow>=3:raise RuntimeError("资源保护暂停：现有阅卷连续响应变慢")
 except Exception as e:status.update(paused=True,reason=str(e))
 target=directory/"health.json";tmp=directory/"health.tmp"
 tmp.write_text(json.dumps(status,ensure_ascii=False));os.chmod(tmp,0o644);tmp.replace(target)
 time.sleep(30)
