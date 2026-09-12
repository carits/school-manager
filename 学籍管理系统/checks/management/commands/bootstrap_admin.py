import os
import secrets
from pathlib import Path
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

class Command(BaseCommand):
    help='Create admin once; store random credential in a private file, never stdout.'
    def add_arguments(self,parser):parser.add_argument('--credential-file',required=True)
    def handle(self,*args,**options):
        User=get_user_model()
        if User.objects.filter(username='school_admin').exists():self.stdout.write('Admin already exists.');return
        path=Path(options['credential_file'])
        if path.exists():raise CommandError('Credential file already exists; refusing to overwrite.')
        password=secrets.token_urlsafe(24)
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:f.write('Username: school_admin\nPassword: '+password+'\n')
        User.objects.create_superuser('school_admin','',password)
        self.stdout.write('Administrator created. Credential saved privately; values hidden.')
