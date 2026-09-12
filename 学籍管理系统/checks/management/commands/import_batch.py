from pathlib import Path
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from checks.models import Batch
from checks.services import parse_import, commit_import

class Command(BaseCommand):
    help = 'Import a validated production workbook from a local path.'
    def add_arguments(self, parser):
        parser.add_argument('path')
        parser.add_argument('--title', required=True)
        parser.add_argument('--activate', action='store_true')
    def handle(self, *args, **options):
        if settings.DEMO_MODE or not settings.HTTPS_ENABLED or not settings.PUBLIC_URL.startswith('https://'):
            raise CommandError('Production import requires HTTPS production mode.')
        path = Path(options['path']).resolve()
        if not path.is_file() or path.suffix.lower() != '.xlsx':
            raise CommandError('The supplied .xlsx file does not exist.')
        rows, fingerprint = parse_import(path.read_bytes())
        if Batch.objects.filter(fingerprint=fingerprint).exists():
            raise CommandError('This workbook content has already been imported.')
        with transaction.atomic():
            batch = commit_import(rows, fingerprint, options['title'][:100], 'system-import', demo=False)
            if options['activate']:
                Batch.objects.filter(active=True).update(active=False)
                batch.active = True
                batch.save(update_fields=['active'])
        self.stdout.write(f'Imported and validated {len(rows)} students; batch id={batch.pk}; active={batch.active}.')
