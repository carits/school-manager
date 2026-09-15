from django.core.management import call_command
from django.test import TestCase

from checks.crypto import encrypt, digest, identity
from checks.management.commands.restore_legacy_national_id_reviews import repair_candidate
from checks.models import Batch, Student, Submission


class RestoreLegacyNationalIdReviewsTests(TestCase):
    def setUp(self):
        self.batch = Batch.objects.create(title='test', fingerprint='restore-test', active=True)
        original = {'A': 'serial', 'B': '学生', 'I': '居民身份证', 'J': '430102201401010018', 'V': '2601', 'Y': 'G430100000000000001'}
        self.student = Student.objects.create(
            batch=self.batch, source_row=2, serial_hash=digest('serial'),
            identity_hash=identity(original['B'], original['J']), name=original['B'],
            class_name=original['V'], original_cipher=encrypt(original), status='submitted',
        )
        self.original_draft = {'B': {'result': 'confirmed', 'value': '学生', 'mode': 'direct'},
                               'Y': {'result': 'unconfirmed', 'note': '', 'mode': 'direct'}}
        self.student.draft_cipher = encrypt(self.original_draft)
        self.student.save(update_fields=['draft_cipher'])
        Submission.objects.create(student=self.student, version=1, payload_cipher=encrypt({
            'values': {'B': '学生'},
            'checks': {'Y': {'result': 'unconfirmed', 'note': ''}},
            'changes': {}, 'signature': 'existing-signature',
        }))

    def test_command_only_restores_target_field_and_reopens_candidate(self):
        original_cipher = self.student.original_cipher
        submission_cipher = self.student.submissions.get().payload_cipher
        call_command('restore_legacy_national_id_reviews', apply=True, expected_count=1)
        self.student.refresh_from_db()
        self.assertEqual(self.student.status, 'draft')
        self.assertTrue(self.student.has_issue)
        self.assertEqual(self.student.revision, 1)
        self.assertEqual(self.student.draft['B'], self.original_draft['B'])
        self.assertEqual(self.student.draft['Y'], {
            'result': 'unconfirmed', 'value': 'G430100000000000001', 'note': '', 'mode': 'direct',
        })
        self.assertEqual(self.student.original_cipher, original_cipher)
        self.assertEqual(self.student.submissions.get().payload_cipher, submission_cipher)

    def test_later_parent_value_is_not_a_candidate(self):
        Submission.objects.create(student=self.student, version=2, payload_cipher=encrypt({
            'values': {'Y': 'G430100000000000002'},
            'checks': {'Y': {'result': 'confirmed', 'value': 'G430100000000000002'}},
            'changes': {}, 'signature': 'new-signature',
        }))
        self.assertIsNone(repair_candidate(self.student))

    def test_draft_being_edited_is_not_a_candidate(self):
        draft = self.student.draft
        draft['Y'] = {'result': 'unconfirmed', 'value': 'G430100000000000009', 'mode': 'direct'}
        self.student.draft_cipher = encrypt(draft)
        self.student.status = 'draft'
        self.student.save(update_fields=['draft_cipher', 'status'])
        self.assertIsNone(repair_candidate(self.student))
