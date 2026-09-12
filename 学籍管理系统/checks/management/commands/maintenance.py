from datetime import timedelta
from django.core.management.base import BaseCommand
from django.core.management import call_command
from django.utils import timezone
from checks.models import Throttle, ImportPreview

class Command(BaseCommand):
    def handle(self,*args,**options):
        Throttle.objects.filter(started_at__lt=timezone.now()-timedelta(days=1)).delete()
        ImportPreview.objects.filter(created_at__lt=timezone.now()-timedelta(minutes=30)).delete()
        call_command('clearsessions')
