from django.db import models
from .crypto import decrypt
class Batch(models.Model):
 title=models.CharField(max_length=120); fingerprint=models.CharField(max_length=64,unique=True); active=models.BooleanField(default=True); is_open=models.BooleanField(default=True); created_at=models.DateTimeField(auto_now_add=True)
class Student(models.Model):
 batch=models.ForeignKey(Batch,on_delete=models.PROTECT); source_row=models.PositiveIntegerField(); name=models.CharField(max_length=100); name_key=models.CharField(max_length=64); identity_cipher=models.TextField(); identity_key=models.CharField(max_length=64); class_name=models.CharField(max_length=50); original_phone_cipher=models.TextField(blank=True); current_phone_cipher=models.TextField(blank=True); status=models.CharField(max_length=16,choices=[('new','未开始'),('draft','核对中'),('submitted','已确认')],default='new'); phone_issue=models.BooleanField(default=False); revision=models.PositiveIntegerField(default=0); submitted_at=models.DateTimeField(null=True,blank=True); updated_at=models.DateTimeField(auto_now=True)
 @property
 def identity(self): return decrypt(self.identity_cipher).get('value','')
 @property
 def original_phone(self): return decrypt(self.original_phone_cipher).get('value','')
 @property
 def current_phone(self): return decrypt(self.current_phone_cipher).get('value','') if self.current_phone_cipher else self.original_phone
class Submission(models.Model):
 student=models.ForeignKey(Student,related_name='submissions',on_delete=models.PROTECT); version=models.PositiveIntegerField(); phone_cipher=models.TextField(); issue=models.BooleanField(default=False); created_at=models.DateTimeField(auto_now_add=True)
 @property
 def phone(self): return decrypt(self.phone_cipher).get('value','')
 class Meta: constraints=[models.UniqueConstraint(fields=['student','version'],name='unique_yanchi_submission')]
