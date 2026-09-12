import concurrent.futures
import json
import re
import time
import uuid
from django.conf import settings
from django.core.management.base import BaseCommand,CommandError
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from checks.crypto import encrypt,digest,identity
from checks.models import Batch,Student
from checks.schema import GROUPS
from checks.management.commands.seed_demo import demo_rows
import requests

class Command(BaseCommand):
    help='50 isolated fictional draft sessions; never operates on real student records.'
    def handle(self,*args,**options):
        if not settings.DEMO_MODE:raise CommandError('Only available in demo mode.')
        batch=Batch.objects.get(active=True,demo=True,is_open=True)
        students=[];sessions=[];run=uuid.uuid4().hex
        try:
            for i in range(50):
                values=demo_rows()[0]['values'];values['A']=f'LOAD-{run}-{i}';values['B']=f'LOAD-{i}';values['J']=f'LOAD-ID-{run}-{i}'
                s=Student.objects.create(batch=batch,source_row=10000+i,serial_hash=digest(values['A']),identity_hash=identity(values['B'],values['J']),name=values['B'],class_name='LOAD',original_cipher=encrypt(values))
                students.append(s.pk);session=SessionStore();session['student_id']=str(s.pk);session.save();sessions.append((session.session_key,dict(values)))
            def run_one(item):
                key,values=item
                start=time.monotonic();client=requests.Session();client.cookies.set('xueji_session',key)
                url='http://127.0.0.1:8000/xueji/check/1/'
                response=client.get(url,timeout=60);response.raise_for_status()
                token=re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"',response.text).group(1)
                data={'csrfmiddlewaretoken':token,'revision':'0','action':'save'}
                data.update({'result_'+f['key']:'confirmed' for f in GROUPS[0]})
                data.update({'value_'+f['key']:values.get(f['key'],'') for f in GROUPS[0] if not f['readonly']})
                data['loaded_J']='1'
                response=client.post(url,data=data,timeout=60);response.raise_for_status()
                if 'value="1"' not in response.text:raise RuntimeError('Draft revision not advanced')
                return time.monotonic()-start
            start=time.monotonic()
            with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:times=list(pool.map(run_one,sessions))
            if Student.objects.filter(pk__in=students,status='draft',revision=1).count()!=50:raise CommandError('Not all drafts persisted')
            times.sort()
            self.stdout.write(json.dumps({'sessions':50,'requests':100,'saved':50,'errors':0,'elapsed_seconds':round(time.monotonic()-start,2),'session_p95_seconds':round(times[47],2),'session_max_seconds':round(max(times),2)}))
        finally:
            Session.objects.filter(session_key__in=[key for key,_ in sessions]).delete()
            Student.objects.filter(pk__in=students).delete()
