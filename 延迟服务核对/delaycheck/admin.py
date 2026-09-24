from django.contrib import admin
from .models import Batch,Student,Submission
@admin.register(Batch)
class BatchAdmin(admin.ModelAdmin): list_display=('title','active','is_open','created_at'); list_filter=('active','is_open')
@admin.register(Student)
class StudentAdmin(admin.ModelAdmin): list_display=('class_name','name','status','phone_issue','submitted_at'); list_filter=('class_name','status','phone_issue'); search_fields=('name','class_name')
@admin.register(Submission)
class SubmissionAdmin(admin.ModelAdmin): list_display=('student','version','issue','created_at'); readonly_fields=('student','version','issue','created_at')
