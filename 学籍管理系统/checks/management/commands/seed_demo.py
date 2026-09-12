import hashlib
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from checks.models import Batch
from checks.schema import FIELDS, VISIBLE
from checks.services import commit_import

def demo_rows():
    rows=[]
    for i,name in enumerate(['演示学生甲','演示学生乙','演示学生丙','演示学生丁','演示学生戊'],1):
        values={f['key']:'' for f in FIELDS}
        for f in VISIBLE:
            if f['options']:values[f['key']]=f['options'][0]
        values.update({'A':f'DEMO2026{i:04d}','B':name,'C':'男','D':'20140101','G':'汉族','H':'中国',
                       'I':'其他','J':f'DEMO202600{i}','K':'非港澳台侨','V':'2601' if i<4 else '2602','Y':f'DEMO-NATIONAL-{i:04d}',
                       'Q':'湖南省长沙市雨花区','R':'演示街道 1 号（虚构）','Z':'湖南省长沙市雨花区','AA':'演示街道 2 号（虚构）',
                       'AV':'否','BC':'否','BI':'演示监护人','BJ':'父亲','BO':'湖南省长沙市雨花区','BP':'演示街道 3 号（虚构）',
                       'BQ':'00000000000','BR':'是','BS':'其他','BT':f'DEMO-GUARDIAN-{i:03d}', 'N':'DEMO-OPTIONAL-PRESERVED'})
        if i==2:values['AA']=''
        if i==3:values['Y']=''
        rows.append({'row':i+1,'values':values})
    return rows

class Command(BaseCommand):
    help='Create five explicitly fictional demo students, never real data.'
    def handle(self,*args,**options):
        if not settings.DEMO_MODE:raise CommandError('Demo seed is disabled in production mode.')
        fingerprint=hashlib.sha256(b'student-check-demo-v1').hexdigest()
        if Batch.objects.filter(fingerprint=fingerprint).exists():self.stdout.write('Demo already exists.');return
        batch=commit_import(demo_rows(),fingerprint,'2026级新生 · 虚构演示','system',demo=True)
        if not Batch.objects.filter(active=True).exists():batch.active=True;batch.save()
        self.stdout.write('Created 5 fictional demo students.')
