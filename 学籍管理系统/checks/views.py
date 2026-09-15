import io
import secrets
from datetime import timedelta
from functools import wraps
from urllib.parse import quote
from PIL import Image, ImageDraw, ImageFont
import qrcode
from django.conf import settings
from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.db import IntegrityError, transaction
from django.db.models import Count, Q, F, Prefetch
from django.http import HttpResponse, HttpResponseForbidden, HttpResponseRedirect, JsonResponse
from django.shortcuts import render, redirect, get_object_or_404
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST, require_GET
from .crypto import encrypt, decrypt, identity, digest, normalize
from .models import Batch, Student, Submission, ImportPreview, Throttle
from .schema import GROUPS, GROUP_NAMES, VISIBLE, SENSITIVE, BY_KEY, REGION_KEYS, validate_checks, check_status, check_value, text_value
from .regions import REGION_TREE
from .services import attempt, save_draft, submit, parse_import, commit_import, audit, export_workbook, reopen, needs_school_attention, public_review_issues

def common_context(request):
    return {'demo_mode':settings.DEMO_MODE, 'group_names':GROUP_NAMES}

def current_batch(): return Batch.objects.filter(active=True).first()

def parent_required(view):
    @wraps(view)
    def wrapped(request,*args,**kwargs):
        sid=request.session.get('student_id')
        student=Student.objects.select_related('batch').filter(pk=sid).first() if sid else None
        if not student or not student.batch.active or (settings.DEMO_MODE and not student.batch.demo):
            request.session.pop('student_id',None); return redirect('login')
        request.student=student
        if not student.batch.is_open: return render(request,'closed.html',{'batch':student.batch},status=403)
        return view(request,*args,**kwargs)
    return wrapped

def login(request):
    batch=current_batch();error=''
    if not batch or not batch.is_open or (settings.DEMO_MODE and not batch.demo):
        return render(request,'closed.html',{'batch':batch})
    if request.method=='POST':
        name=normalize(request.POST.get('name',''))[:100]; number=normalize(request.POST.get('number',''))[:100].upper()
        ip=request.META.get('REMOTE_ADDR','')
        cap=request.session.pop('captcha',None)
        permitted=attempt('login-ip:'+ip,30,300) and attempt('login-id:'+identity(name,number),10,300)
        valid=cap and timezone.now().timestamp()-cap['time']<300 and secrets.compare_digest(cap['hash'],digest(request.POST.get('captcha','').strip().upper()))
        student=Student.objects.filter(batch=batch,identity_hash=identity(name,number)).first() if permitted and valid else None
        if student:
            # Successful parents sharing a school/home network do not consume failure quota.
            Throttle.objects.filter(key__in=[digest('login-ip:'+ip),digest('login-id:'+identity(name,number))],count__gt=0).update(count=F('count')-1)
            request.session.flush();request.session['student_id']=str(student.pk);request.session.set_expiry(1800)
            return redirect('result' if student.status=='submitted' else 'step',**({} if student.status=='submitted' else {'index':1}))
        error='输入信息或验证码不匹配，请检查后重试。' if permitted else '尝试次数较多，请 5 分钟后再试。'
    return render(request,'login.html',{'batch':batch,'error':error})

@require_GET
def captcha(request):
    if not attempt('captcha:'+request.META.get('REMOTE_ADDR',''),120,300): return HttpResponse(status=429)
    code=''.join(secrets.choice('23456789ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(5))
    request.session['captcha']={'hash':digest(code),'time':timezone.now().timestamp()}
    im=Image.new('RGB',(180,58),'#eef4fb');draw=ImageDraw.Draw(im)
    font=ImageFont.load_default(size=32)
    for _ in range(8):
        draw.line((secrets.randbelow(180),secrets.randbelow(58),secrets.randbelow(180),secrets.randbelow(58)),fill='#a3bad1',width=1)
    for i,char in enumerate(code): draw.text((12+i*32,8+secrets.randbelow(8)),char,font=font,fill='#153958')
    data=io.BytesIO();im.save(data,format='PNG');return HttpResponse(data.getvalue(),content_type='image/png')

@require_POST
def logout(request):
    request.session.flush();return redirect('login')

def region_initial(value):
    selected = {'province_index': '', 'city_index': '', 'district_value': '', 'cities': [], 'districts': []}
    for province_index, province in enumerate(REGION_TREE):
        for city_index, city in enumerate(province['cities']):
            for district in city['districts']:
                if district['value'] == value:
                    selected.update({
                        'province_index': province_index,
                        'city_index': city_index,
                        'district_value': value,
                        'cities': province['cities'],
                        'districts': city['districts'],
                    })
                    return selected
    return selected


def group_index_for(key):
    return next((index for index, fields in enumerate(GROUPS, 1) if any(field['key'] == key for field in fields)), 1)


def field_rows(student,fields,checks,errors=None,revealed_key=None):
    base=student.current();rows=[];errors=errors or {}
    first_error_key=next((f['key'] for f in fields if f['key'] in errors),None)
    for f in fields:
        k=f['key'];item=checks.get(k,{});value=check_value(base,f,item);sensitive=k in SENSITIVE
        sensitive_loaded = sensitive and (not value or k == revealed_key)
        row={**f,'label':f['label'].replace('*',''),'current':value,'sensitive':sensitive,
             'display':(value[:3]+'********'+value[-4:]) if sensitive and value else value,
             'result':check_status(f,item),'new':value if sensitive_loaded else ('' if sensitive else value),'note':item.get('note',''),
             'sensitive_loaded':sensitive_loaded,
             'error':errors.get(k),'first_error':k==first_error_key,
             'region':k in REGION_KEYS,'long_options':len(f['options'])>30}
        if row['region']:
            row['region_initial'] = region_initial(row['new'])
        if k=='D':
            v=row['new'].replace('-','');row['new']=f'{v[:4]}-{v[4:6]}-{v[6:]}' if len(v)==8 else row['new']
        rows.append(row)
    return rows

@parent_required
def step(request,index):
    if index not in range(1,len(GROUPS)+1): return redirect('step',index=1)
    if request.student.status=='submitted':return redirect('result')
    fields=GROUPS[index-1]; errors={}; notice=''
    if request.method=='POST':
        action=request.POST.get('action','next')
        field_keys={field['key'] for field in fields}
        special_key=action.split(':',1)[1] if ':' in action else ''
        valid_action=(action in {'save','next'} or
                      (action.startswith('compat-region:') and special_key in REGION_KEYS and special_key in field_keys) or
                      (action.startswith('reveal-sensitive:') and special_key in SENSITIVE and special_key in field_keys))
        if not valid_action:
            notice='无法识别本次操作，请刷新页面后重试。'
        else:
            checks={}
            for f in fields:
                key=f['key']; value_key='value_'+key
                item={'result':request.POST.get('result_'+key,''),
                      'note':request.POST.get('note_'+key,''),
                      'loaded':request.POST.get('loaded_'+key)=='1'}
                # A form opened before Y became editable has no value_Y control. Keep the
                # current value when that stale page is submitted during the rolling release.
                if value_key in request.POST:item['value']=request.POST.get(value_key,'')
                checks[key]=item
            for k in SENSITIVE:
                if k in checks and 'value' in checks[k]:checks[k]['value']=checks[k]['value'].upper()
            # Opening the server-side region picker must not replace a previously saved
            # value with an incomplete province/city selection from the current page.
            if action.startswith('compat-region:'):checks[special_key].pop('value',None)
            try:
                request.student=save_draft(request.student.pk,int(request.POST.get('revision','-1')),checks,fields)
                if action.startswith('compat-region:'):
                    return redirect('region_compat',key=special_key)
                if action.startswith('reveal-sensitive:'):
                    url=reverse('step',args=[index])+'?reveal='+quote(special_key)+'#field-'+quote(special_key)
                    return HttpResponseRedirect(url)
                if action=='save': messages.success(request,'本步草稿已保存，可稍后继续。')
                else:
                    _,errors=validate_checks(request.student.current(),request.student.draft,fields)
                    if not errors:return redirect('step',index=index+1) if index<len(GROUPS) else redirect('confirm')
            except ValueError as exc:notice=str(exc)
    checks=request.student.draft
    revealed_key=request.GET.get('reveal','')
    if revealed_key not in SENSITIVE or not any(field['key']==revealed_key for field in fields):revealed_key=None
    return render(request,'step.html',{'student':request.student,'index':index,'title':GROUP_NAMES[index-1],
                   'rows':field_rows(request.student,fields,checks,errors,revealed_key),'notice':notice,'error_count':len(errors),'progress':index*20,
                   'region_tree':REGION_TREE,'has_regions':any(f['key'] in REGION_KEYS for f in fields)})

@parent_required
def reveal(request,key):
    if key not in SENSITIVE:return HttpResponseForbidden()
    return JsonResponse({'value':check_value(request.student.current(),BY_KEY[key],request.student.draft.get(key,{}))})


@parent_required
def region_compat(request,key):
    if key not in REGION_KEYS or key not in BY_KEY or BY_KEY[key]['readonly']:
        return HttpResponseForbidden()
    if request.student.status=='submitted':return redirect('result')
    field=BY_KEY[key]; notice=''; selected_value=''
    if request.method=='POST':
        selected_value=request.POST.get('value','')
        if selected_value not in field['options']:
            notice='请选择列表中的完整行政区划。'
        else:
            try:
                request.student=save_draft(
                    request.student.pk,
                    int(request.POST.get('revision','-1')),
                    {key:{'result':'unconfirmed','value':selected_value,'mode':'direct'}},
                    [field],
                )
                index=group_index_for(key)
                return HttpResponseRedirect(reverse('step',args=[index])+'#field-'+quote(key))
            except ValueError as exc:notice=str(exc)

    query=request.GET.get('q','').strip()[:50]
    province_raw=request.GET.get('province','')
    city_raw=request.GET.get('city','')
    province_index=int(province_raw) if province_raw.isdigit() and int(province_raw)<len(REGION_TREE) else None
    province=REGION_TREE[province_index] if province_index is not None else None
    city_index=int(city_raw) if province and city_raw.isdigit() and int(city_raw)<len(province['cities']) else None
    city=province['cities'][city_index] if city_index is not None else None
    results=[]
    if query:
        for p_index,p in enumerate(REGION_TREE):
            for c_index,c in enumerate(p['cities']):
                for district in c['districts']:
                    haystack=p['name']+c['name']+district['name']+district['value']
                    if query in haystack:
                        results.append({'value':district['value'],'label':district['value'],'province_index':p_index,'city_index':c_index})
                        if len(results)>=100:break
                if len(results)>=100:break
            if len(results)>=100:break
    current=check_value(request.student.current(),field,request.student.draft.get(key,{}))
    return render(request,'region_compat.html',{
        'student':request.student,'field':field,'key':key,'notice':notice,'current':current,
        'region_tree':REGION_TREE,'province_index':province_index,'province':province,
        'city_index':city_index,'city':city,'query':query,'results':results,'selected_value':selected_value,
        'return_index':group_index_for(key),
    })

@parent_required
def confirm(request):
    student=request.student
    if student.status=='submitted':return redirect('result')
    values,errors=validate_checks(student.current(),student.draft)
    notice=''
    if request.method=='POST':
        if request.POST.get('ack')!='yes':notice='请勾选真实性确认。'
        elif errors:notice='请先完成所有项目。'
        else:
            try:
                submit(student.pk,int(request.POST.get('revision','-1')),request.POST.get('signature',''));return redirect('result')
            except ValueError as exc:notice=str(exc)
    rows=[];base=student.current();required_confirmed=0;modified_confirmed=0;optional_unconfirmed=0;school_issues=0
    for f in VISIBLE:
        k=f['key'];check=student.draft.get(k,{});status=check_status(f,check)
        if f['required'] and not f['readonly'] and status=='confirmed' and k not in errors: required_confirmed+=1
        if not f['required'] and status=='unconfirmed': optional_unconfirmed+=1
        changed=not f['readonly'] and values.get(k,'')!=text_value(base.get(k,''))
        if changed and status=='confirmed': modified_confirmed+=1
        issue=f['readonly'] and status=='unconfirmed'
        if issue: school_issues+=1
        if changed or issue:
            old=base.get(k,'');new=values.get(k,'')
            if k in SENSITIVE:
                old=old[:3]+'********'+old[-4:] if old else ''
                new=new[:3]+'********'+new[-4:] if new else ''
            rows.append({'label':f['label'].replace('*',''),'old':old,'new':new,'readonly':f['readonly'],'note':check.get('note','')})
    return render(request,'confirm.html',{'student':student,'rows':rows,'errors':errors,'notice':notice,
                   'required_confirmed':required_confirmed,'required_total':sum(f['required'] and not f['readonly'] for f in VISIBLE),
                   'modified_confirmed':modified_confirmed,'optional_unconfirmed':optional_unconfirmed,'school_issues':school_issues,
                   'signature':request.POST.get('signature','') if request.method == 'POST' else ''})

@parent_required
def result(request):
    if request.student.status!='submitted':return redirect('step',index=1)
    if request.method=='POST' and request.POST.get('action')=='reopen':
        reopen(request.student.pk,'家长本人')
        messages.success(request,'已进入新一轮核对，请重新检查并确认全部必填信息。')
        return redirect('step',index=1)
    latest=request.student.submissions.order_by('-version').first()
    payload=latest.payload if latest else {};signature=payload.get('signature','')
    school_issue=needs_school_attention(request.student,payload)
    return render(request,'result.html',{'student':request.student,'signature':signature,'signed':bool(signature),'school_issue':school_issue})

@require_GET
def health(request):
    from django.db import connection
    with connection.cursor() as cursor:cursor.execute('SELECT 1');cursor.fetchone()
    return JsonResponse({'status':'ok','mode':'demo' if settings.DEMO_MODE else 'production'})

@staff_member_required
def dashboard(request):
    batch_id=request.GET.get('batch');batch=get_object_or_404(Batch,pk=batch_id) if batch_id else current_batch()
    query=Student.objects.filter(batch=batch) if batch else Student.objects.none()
    stats={x['status']:x['count'] for x in query.values('status').annotate(count=Count('pk'))}
    total=query.count()
    issue_candidates=query.filter(has_issue=True).prefetch_related(
        Prefetch('submissions',queryset=Submission.objects.order_by('version'),to_attr='issue_submissions')
    )
    issue_ids=[]
    for student in issue_candidates:
        latest=student.issue_submissions[-1].payload if student.issue_submissions else {}
        if needs_school_attention(student,latest):issue_ids.append(student.pk)
    issue_id_set=set(issue_ids);issues=len(issue_ids)
    classes=list(query.values_list('class_name',flat=True).distinct())
    if request.GET.get('q'):query=query.filter(name__icontains=request.GET['q'][:100])
    if request.GET.get('class'):query=query.filter(class_name=request.GET['class'])
    if request.GET.get('status'):query=query.filter(status=request.GET['status'])
    if request.GET.get('issue'):query=query.filter(pk__in=issue_ids)
    from django.core.paginator import Paginator
    page=Paginator(query,50).get_page(request.GET.get('page'))
    for student in page.object_list:student.display_issue=student.pk in issue_id_set
    params=request.GET.copy();params.pop('page',None)
    return render(request,'dashboard.html',{'batch':batch,'batches':Batch.objects.order_by('-pk'),'students':page,
                 'stats':stats,'total':total,'issues':issues,'classes':classes,'public_url':settings.PUBLIC_URL,'querystring':params.urlencode()})

def pending_classes(request,group='regular'):
    groups={'regular':('班级','pending_classes'),'benbu':('本部','pending_head_campus')}
    if group not in groups:return HttpResponse(status=404)
    batch=current_batch()
    query=Student.objects.filter(batch=batch,progress_group=group) if batch else Student.objects.none()
    pending_total=query.exclude(status='submitted').count();submitted_total=query.filter(status='submitted').count()
    issue_map={}
    issue_counts={}
    national_issue_counts={}
    issue_students=query.filter(has_issue=True).prefetch_related(
        Prefetch('submissions',queryset=Submission.objects.order_by('version'),to_attr='progress_submissions')
    )
    for student in issue_students:
        labels=public_review_issues(student)
        if labels:
            issue_map[student.pk]=labels
            issue_counts[student.class_name]=issue_counts.get(student.class_name,0)+1
            if '全国学籍号待重新核对' in labels:
                national_issue_counts[student.class_name]=national_issue_counts.get(student.class_name,0)+1
    issue_ids=set(issue_map)
    national_issue_ids={student_id for student_id,labels in issue_map.items() if '全国学籍号待重新核对' in labels}
    class_rows=[]
    for row in query.values('class_name').annotate(
        total=Count('pk'),submitted=Count('pk',filter=Q(status='submitted')),
        draft=Count('pk',filter=Q(status='draft')),new=Count('pk',filter=Q(status='new')),
    ).order_by('class_name'):
        row['pending']=row['total']-row['submitted']
        row['issues']=issue_counts.get(row['class_name'],0)
        row['national_issues']=national_issue_counts.get(row['class_name'],0)
        row['label']=row['class_name'] or '未分班'
        row['key']=row['class_name'] or '__blank__'
        class_rows.append(row)
    selected_key=request.GET.get('class')
    selected=next((row for row in class_rows if row['key']==selected_key),None) if group=='regular' else None
    status_filter=request.GET.get('status','all' if group=='benbu' else 'pending')
    if status_filter not in {'pending','submitted','issue','national_issue','all'}:status_filter='pending'
    students=query.order_by('class_name','source_row') if group=='benbu' else query.none()
    if group=='benbu':
        if status_filter=='pending':students=students.exclude(status='submitted')
        elif status_filter=='submitted':students=students.filter(status='submitted')
        elif status_filter=='issue':students=students.filter(pk__in=issue_ids)
        elif status_filter=='national_issue':students=students.filter(pk__in=national_issue_ids)
    if selected:
        students=query.filter(class_name=selected['class_name']).order_by('source_row')
        if status_filter=='pending':students=students.exclude(status='submitted')
        elif status_filter=='submitted':students=students.filter(status='submitted')
        elif status_filter=='issue':students=students.filter(pk__in=issue_ids)
        elif status_filter=='national_issue':students=students.filter(pk__in=national_issue_ids)
    selected_count=students.count() if selected or group=='benbu' else 0
    for student in students:student.review_issues=issue_map.get(student.pk,[])
    filter_labels={'pending':'未核对','submitted':'已核对','issue':'核对有误','national_issue':'学籍号有误','all':'全部'}
    return render(request,'pending_classes.html',{
        'batch':batch,'class_rows':class_rows,
        'selected':selected,'students':students,'pending_total':pending_total,'submitted_total':submitted_total,
        'group_total':query.count(),'status_filter':status_filter,'filter_label':filter_labels[status_filter],
        'issue_total':len(issue_ids),
        'national_issue_total':len(national_issue_ids),
        'selected_count':selected_count,'is_head_campus':group=='benbu',
        'standalone':True,'group_label':groups[group][0],'progress_url_name':groups[group][1],
    })

@staff_member_required
def import_students(request):
    # Demo deployments never accept external student records, even from administrators.
    if settings.DEMO_MODE:return render(request,'import.html',{'blocked':True})
    error='';preview=None;sample=[]
    if request.method=='POST':
        if not request.is_secure():return HttpResponseForbidden('导入真实数据必须使用 HTTPS。')
        try:
            if request.POST.get('confirm'):
                with transaction.atomic():
                    p=get_object_or_404(ImportPreview.objects.select_for_update(),pk=request.POST['confirm'],owner=request.user)
                    if p.created_at<timezone.now()-timedelta(minutes=30):raise ValueError('预览已过期，请重新上传。')
                    batch=commit_import(decrypt(p.payload_cipher),p.fingerprint,p.title,request.user)
                    p.delete()
                messages.success(request,'导入完成。请检查名单后将该批次设为当前批次。')
                return redirect('/xueji/manage/?batch='+str(batch.pk))
            upload=request.FILES.get('file');title=request.POST.get('title','').strip()
            if not upload or not title:raise ValueError('请填写批次名称并选择文件。')
            rows,fingerprint=parse_import(upload.read())
            if Batch.objects.filter(fingerprint=fingerprint).exists():raise ValueError('该名单已导入，请勿重复上传。')
            preview=ImportPreview.objects.create(owner=request.user,title=title[:100],fingerprint=fingerprint,payload_cipher=encrypt(rows))
            sample=[{'name':r['values']['B'],'class_name':r['values']['V'], 'missing':sum(not r['values'].get(f['key']) for f in VISIBLE)} for r in rows[:10]]
        except (ValueError,IntegrityError) as exc:
            error=str(exc) if isinstance(exc,ValueError) else '名单已导入或存在重复记录。'
    return render(request,'import.html',{'error':error,'preview':preview,'sample':sample,'count':len(rows) if preview else 0})

@staff_member_required
@require_POST
def batch_action(request,pk):
    with transaction.atomic():
        batch=get_object_or_404(Batch.objects.select_for_update(),pk=pk)
        if request.POST.get('action')=='activate':
            if settings.DEMO_MODE and not batch.demo:return HttpResponseForbidden()
            Batch.objects.filter(active=True).update(active=False);batch.active=True
        elif request.POST.get('action')=='toggle':batch.is_open=not batch.is_open
        else:return HttpResponse(status=400)
        batch.save();audit(request.user,'批次 '+request.POST['action'],batch.pk)
    return redirect('/xueji/manage/?batch='+str(batch.pk))

@staff_member_required
def student_detail(request,pk):
    student=get_object_or_404(Student,pk=pk)
    if request.method=='POST':
        if request.POST.get('action')=='reopen':
            reopen(student.pk,request.user);messages.success(request,'已重新开放，家长需重新逐项确认。')
        elif request.POST.get('action')=='school':
            with transaction.atomic():
                student=Student.objects.select_for_update().get(pk=pk)
                before=student.school;class_name=request.POST.get('V','').strip()[:100]
                if not class_name:messages.error(request,'班级必须填写。')
                else:
                    school=dict(before);school['V']=class_name
                    student.school_cipher=encrypt(school);student.class_name=class_name;student.has_issue=False;student.revision+=1
                    student.save(update_fields=['school_cipher','class_name','has_issue','revision'])
                    audit(request.user,'维护班级',student.pk,{'before':before.get('V',''),'after':class_name})
                    messages.success(request,'班级已更新，待处理标记已解除。')
        return redirect('student_detail',pk=pk)
    rows=field_rows(student,VISIBLE,student.draft)
    history=[{'version':s.version,'created_at':s.created_at,'changes':[{'label':BY_KEY[k]['label'].replace('*',''),**v} for k,v in s.payload['changes'].items()]} for s in student.submissions.order_by('-version')]
    latest=student.submissions.order_by('-version').first()
    issues=[{'label':BY_KEY[k]['label'].replace('*',''),'note':v.get('note','')} for k,v in (latest.payload['checks'] if latest else {}).items() if student.has_issue and k=='V' and check_status(BY_KEY[k],v)=='unconfirmed']
    audit(request.user,'查看学生详情',student.pk)
    return render(request,'student_detail.html',{'student':student,'rows':rows,'history':history,'school_values':student.current(),'issues':issues})

@staff_member_required
def export(request,pk,kind):
    if kind not in {'final','review','changes','pending','confirmations'}:return HttpResponse(status=404)
    batch=get_object_or_404(Batch,pk=pk)
    class_key=request.GET.get('class') if kind=='pending' else None
    class_name='' if class_key=='__blank__' else class_key
    if class_key is not None and not Student.objects.filter(batch=batch,class_name=class_name).exists():return HttpResponse(status=404)
    data=export_workbook(batch,kind,class_name=class_name if class_key is not None else None)
    audit(request.user,'导出 '+kind,batch.pk,{'class_name':class_name} if class_key is not None else {})
    prefix=(class_name or '未分班') if class_key is not None else ''
    name=prefix+{'final':'学籍最终数据','review':'学校自行核对表','changes':'家长修改明细','pending':'未完成核对学生','confirmations':'家长逐项确认与签名'}[kind]+'.xlsx'
    response=HttpResponse(data,content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    response['Content-Disposition']="attachment; filename*=UTF-8''"+quote(name)
    return response

@staff_member_required
def qr(request):
    im=qrcode.make(settings.PUBLIC_URL);stream=io.BytesIO();im.save(stream,format='PNG')
    response=HttpResponse(stream.getvalue(),content_type='image/png')
    response['Content-Disposition']='attachment; filename="student-check-qr.png"'
    return response

@staff_member_required
def template_download(request):
    return HttpResponse((settings.BASE_DIR/'assets/template.xlsx').read_bytes(),content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={'Content-Disposition':"attachment; filename*=UTF-8''"+quote('新生导入模板.xlsx')})
