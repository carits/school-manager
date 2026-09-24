import random,string,html
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.http import HttpResponse
from django.shortcuts import get_object_or_404,redirect,render
from django.utils import timezone
from .crypto import lookup,encrypt
from .models import Batch,Student,Submission
def captcha(request):
 code=''.join(random.choice(string.ascii_uppercase+string.digits) for _ in range(4)); request.session['yanchi_captcha']=code
 text=''.join('<text x="{}" y="{}" transform="rotate({} {} {})">{}</text>'.format(18+i*25, random.randint(29,40), random.randint(-12,12), 18+i*25, 30, html.escape(ch)) for i,ch in enumerate(code))
 lines=''.join('<line x1="{}" y1="{}" x2="{}" y2="{}"/>'.format(random.randint(0,95),random.randint(8,48),random.randint(90,160),random.randint(8,48)) for _ in range(5))
 body='<svg xmlns="http://www.w3.org/2000/svg" width="150" height="52" viewBox="0 0 150 52"><rect width="150" height="52" rx="6" fill="#f2f6fb"/><g stroke="#9fb4cc" stroke-width="1">{}</g><g fill="#1f5e9c" font-family="Arial,sans-serif" font-size="24" font-weight="700">{}</g></svg>'.format(lines,text)
 response=HttpResponse(body,content_type='image/svg+xml; charset=utf-8'); response['Cache-Control']='no-store'; return response
def login(request):
 if request.method=='POST':
  name=request.POST.get('name','').strip(); identity=request.POST.get('identity','').strip().upper(); code=request.POST.get('captcha','').strip().upper()
  if code!=request.session.get('yanchi_captcha'): return render(request,'delaycheck/login.html',{'error':'验证码不正确。'})
  student=Student.objects.filter(batch__active=True,name_key=lookup(name),identity_key=lookup(identity)).first()
  if not student:return render(request,'delaycheck/login.html',{'error':'姓名或身份证号不匹配，请使用学校登记信息。'})
  request.session['yanchi_student_id']=student.pk; return redirect('check')
 return render(request,'delaycheck/login.html')
def current_student(request): return get_object_or_404(Student,pk=request.session.get('yanchi_student_id'),batch__active=True)
def check(request):
 student=current_student(request)
 if not student.batch.is_open:return render(request,'delaycheck/closed.html')
 if request.method=='POST':
  phone=request.POST.get('phone','').strip(); result=request.POST.get('result')
  if not phone or not phone.isdigit() or len(phone)!=11 or not phone.startswith('1'): return render(request,'delaycheck/check.html',{'student':student,'error':'请输入有效的11位手机号码。'})
  if result not in {'confirmed','issue'}: return render(request,'delaycheck/check.html',{'student':student,'error':'请选择手机号是否正确。'})
  with transaction.atomic():
   locked=Student.objects.select_for_update().get(pk=student.pk); version=locked.submissions.count()+1
   Submission.objects.create(student=locked,version=version,phone_cipher=encrypt({'value':phone}),issue=result=='issue')
   locked.current_phone_cipher=encrypt({'value':phone}); locked.status='submitted'; locked.phone_issue=result=='issue'; locked.submitted_at=timezone.now(); locked.revision+=1; locked.save()
  return redirect('result')
 return render(request,'delaycheck/check.html',{'student':student,'phone':student.current_phone})
def result(request):
 student=current_student(request); latest=student.submissions.order_by('-version').first()
 if request.method=='POST': student.status='draft';student.revision+=1;student.save(update_fields=['status','revision','updated_at']);return redirect('check')
 return render(request,'delaycheck/result.html',{'student':student,'latest':latest})
def progress(request):
 batch=Batch.objects.filter(active=True).first(); klass=request.GET.get('class',''); status=request.GET.get('status','all'); qs=Student.objects.filter(batch=batch)
 classes=list(qs.values_list('class_name',flat=True).distinct().order_by('class_name')) if batch else []
 if klass: qs=qs.filter(class_name=klass)
 if status=='pending':qs=qs.exclude(status='submitted')
 elif status=='submitted':qs=qs.filter(status='submitted')
 elif status=='issue':qs=qs.filter(phone_issue=True)
 return render(request,'delaycheck/progress.html',{'batch':batch,'classes':classes,'selected_class':klass,'status':status,'students':qs.order_by('class_name','name'),'total':qs.count()})
def logout(request): request.session.flush();return redirect('login')
def health(request): return JsonResponse({'status':'ok','service':'yanchi'})
