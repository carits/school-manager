import uuid
from django.db import models
from .crypto import encrypt, decrypt

class Batch(models.Model):
    title = models.CharField('批次名称', max_length=100)
    fingerprint = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField('导入时间', auto_now_add=True)
    active = models.BooleanField('当前批次', default=False)
    is_open = models.BooleanField('开放家长核对', default=True)
    demo = models.BooleanField('虚构演示数据', default=False)
    class Meta:
        verbose_name = '导入批次'
        verbose_name_plural = verbose_name
        constraints = [models.UniqueConstraint(fields=['active'], condition=models.Q(active=True), name='one_active_batch')]
    def __str__(self): return self.title

class Student(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    batch = models.ForeignKey(Batch, on_delete=models.PROTECT)
    source_row = models.PositiveIntegerField()
    serial_hash = models.CharField(max_length=64)
    identity_hash = models.CharField(max_length=64)
    name = models.CharField('姓名', max_length=100)
    class_name = models.CharField('班级', max_length=100, blank=True)
    progress_group = models.CharField('进度名单分组', max_length=32, default='regular', db_index=True)
    original_cipher = models.TextField()
    school_cipher = models.TextField(blank=True)
    draft_cipher = models.TextField(blank=True)
    revision = models.PositiveIntegerField(default=0)
    status = models.CharField('核对状态', max_length=16, choices=[('new','未开始'),('draft','核对中'),('submitted','已提交')], default='new')
    has_issue = models.BooleanField('学校待处理', default=False)
    change_count = models.PositiveIntegerField('更正项数', default=0)
    submitted_at = models.DateTimeField('提交时间', null=True, blank=True)
    class Meta:
        verbose_name = '学生'
        verbose_name_plural = verbose_name
        ordering = ['source_row']
        constraints = [models.UniqueConstraint(fields=['batch','serial_hash'], name='unique_batch_serial'),
                       models.UniqueConstraint(fields=['batch','identity_hash'], name='unique_batch_identity')]
    def __str__(self): return f'{self.class_name} {self.name}'
    @property
    def original(self): return decrypt(self.original_cipher)
    @property
    def school(self): return decrypt(self.school_cipher)
    @property
    def draft(self): return decrypt(self.draft_cipher)
    def current(self):
        values = self.original
        prefetched = getattr(self, '_prefetched_objects_cache', {}).get('submissions')
        if prefetched is None:
            latest = self.submissions.order_by('-version').first()
        else:
            latest = max(prefetched, key=lambda submission: submission.version, default=None)
        submitted = latest.payload['values'] if latest else {}
        if latest:
            values.update(submitted)
        values.update(self.school)
        # Y changed from school-maintained to parent-editable. Historical submissions do not
        # contain Y, while new submissions must take precedence over its old school baseline.
        if 'Y' in submitted:
            values['Y'] = submitted['Y']
        return values

class Submission(models.Model):
    student = models.ForeignKey(Student, related_name='submissions', on_delete=models.PROTECT)
    version = models.PositiveIntegerField('提交版本')
    payload_cipher = models.TextField()
    created_at = models.DateTimeField('提交时间', auto_now_add=True)
    class Meta:
        verbose_name = '提交历史'
        verbose_name_plural = verbose_name
        constraints = [models.UniqueConstraint(fields=['student','version'], name='unique_submission_version')]
    @property
    def payload(self): return decrypt(self.payload_cipher)

class ImportPreview(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey('auth.User', on_delete=models.CASCADE)
    fingerprint = models.CharField(max_length=64)
    payload_cipher = models.TextField()
    title = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)

class Audit(models.Model):
    actor = models.CharField('操作人', max_length=100)
    action = models.CharField('操作', max_length=100)
    target = models.CharField('对象', max_length=100)
    detail_cipher = models.TextField(blank=True)
    created_at = models.DateTimeField('时间', auto_now_add=True)
    class Meta:
        verbose_name = '操作记录'
        verbose_name_plural = verbose_name
        ordering = ['-created_at']

class Throttle(models.Model):
    key = models.CharField(max_length=64, primary_key=True)
    count = models.PositiveIntegerField(default=0)
    started_at = models.DateTimeField()
