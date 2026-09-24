import hashlib,openpyxl
from django.core.management.base import BaseCommand,CommandError
from django.db import transaction
from delaycheck.models import Batch,Student
from delaycheck.crypto import encrypt,lookup
class Command(BaseCommand):
 help='Import the delay-service intention workbook without committing the source file.'
 def add_arguments(self,p): p.add_argument('path');p.add_argument('--title',default='延时服务手机核对')
 def handle(self,*a,**opts):
  path=opts['path']; raw=open(path,'rb').read(); fingerprint=hashlib.sha256(raw).hexdigest()
  if Batch.objects.filter(fingerprint=fingerprint).exists(): raise CommandError('该文件已经导入。')
  wb=openpyxl.load_workbook(path,read_only=True,data_only=True); ws=wb.active; rows=list(ws.iter_rows(values_only=True))
  if len(rows)<2: raise CommandError('工作表没有学生数据。')
  header=[str(x or '').strip() for x in rows[1][:5]]
  title=opts['title']; records=[]; names=set();ids=set()
  for number,row in enumerate(rows[2:],3):
   klass,name,identity,phone,remark=[str(x or '').strip() for x in list(row[:5])+['']*5][:5]
   if not name and not identity and not klass: continue
   if not name or not identity or not klass: raise CommandError(f'第{number}行姓名、身份证号、班级不能为空。')
   ik=lookup(identity); nk=lookup(name)
   if ik in ids: raise CommandError(f'第{number}行身份证号重复。')
   ids.add(ik); names.add(nk); records.append((number,klass,name,identity,phone))
  with transaction.atomic():
   batch=Batch.objects.create(title=title,fingerprint=fingerprint)
   Student.objects.bulk_create([Student(batch=batch,source_row=r,name=name,name_key=nk,identity_cipher=encrypt({'value':identity}),identity_key=ik,class_name=klass,original_phone_cipher=encrypt({'value':phone}) if phone else '') for r,klass,name,identity,phone in records])
  self.stdout.write(self.style.SUCCESS(f'导入完成：{len(records)}人，批次={batch.pk}'))
