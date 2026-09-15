from django.contrib import admin
from .models import Batch, Student, Submission, Audit
admin.site.site_header='学籍核对管理'
admin.site.site_title='学籍核对'
admin.site.index_title='管理与记录'
admin.site.site_url='/xueji/manage/'

class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self,request):return False
    def has_change_permission(self,request,obj=None):return False
    def has_delete_permission(self,request,obj=None):return False

@admin.register(Batch)
class BatchAdmin(ReadOnlyAdmin):
    list_display=['title','active','is_open','demo','created_at']
    fields=list_display

@admin.register(Student)
class StudentAdmin(ReadOnlyAdmin):
    list_display=['name','class_name','progress_group','status','change_count','submitted_at']
    list_filter=['batch','progress_group','status','class_name']
    search_fields=['name']
    fields=list_display

@admin.register(Submission)
class SubmissionAdmin(ReadOnlyAdmin):
    list_display=['student','version','created_at']
    fields=list_display

@admin.register(Audit)
class AuditAdmin(ReadOnlyAdmin):
    list_display=['actor','action','target','created_at']
    fields=list_display
