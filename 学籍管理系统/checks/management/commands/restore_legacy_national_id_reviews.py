from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from checks.crypto import encrypt
from checks.models import Batch, Student
from checks.schema import text_value


def legacy_issue(submission):
    payload = submission.payload
    values = payload.get('values', {})
    item = payload.get('checks', {}).get('Y', {})
    if 'Y' in values or item.get('result') not in {'incorrect', 'unconfirmed'}:
        return None
    return item


def repair_candidate(student):
    flagged = []
    submitted_values = []
    for submission in student.submissions.order_by('version'):
        issue = legacy_issue(submission)
        if issue is not None:
            flagged.append((submission.version, issue))
        if 'Y' in submission.payload.get('values', {}):
            submitted_values.append(submission.version)
    if not flagged:
        return None
    version, issue = flagged[-1]
    if any(later > version for later in submitted_values):
        return None
    current = student.draft.get('Y', {})
    if 'value' in current or current.get('result') == 'confirmed':
        return None
    if student.status != 'submitted':
        return None
    return issue


class Command(BaseCommand):
    help = 'Restore unresolved legacy national student ID reviews without changing other student data.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--expected-count', type=int)

    def handle(self, *args, **options):
        batch = Batch.objects.filter(active=True).first()
        if not batch:
            raise CommandError('No active batch.')
        candidates = []
        for student in Student.objects.filter(batch=batch).prefetch_related('submissions'):
            issue = repair_candidate(student)
            if issue is not None:
                candidates.append((student.pk, issue))
        self.stdout.write(f'candidates={len(candidates)}')
        if not options['apply']:
            self.stdout.write('dry_run=true')
            return
        expected = options.get('expected_count')
        if expected is None or expected != len(candidates):
            raise CommandError('Candidate count changed; run dry-run again and provide --expected-count.')
        repaired = 0
        with transaction.atomic():
            for student_id, _ in candidates:
                student = Student.objects.select_for_update().get(pk=student_id)
                issue = repair_candidate(student)
                if issue is None:
                    raise CommandError('A candidate changed while repair was running; transaction rolled back.')
                draft = student.draft
                draft['Y'] = {
                    'result': 'unconfirmed',
                    'value': text_value(student.current().get('Y', '')),
                    'note': str(issue.get('note', ''))[:500],
                    'mode': 'direct',
                }
                student.draft_cipher = encrypt(draft)
                student.status = 'draft'
                student.has_issue = True
                student.revision += 1
                student.save(update_fields=['draft_cipher', 'status', 'has_issue', 'revision'])
                repaired += 1
        self.stdout.write(f'repaired={repaired}')
