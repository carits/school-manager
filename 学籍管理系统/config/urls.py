from django.contrib import admin
from django.urls import path
from checks import views as v
urlpatterns=[
    path('xueji/',v.login,name='login'),path('xueji/login/',v.login),
    path('xueji/captcha/',v.captcha,name='captcha'),path('xueji/logout/',v.logout,name='logout'),
    path('xueji/check/<int:index>/',v.step,name='step'),path('xueji/reveal/<str:key>/',v.reveal,name='reveal'),
    path('xueji/compat/region/<str:key>/',v.region_compat,name='region_compat'),
    path('xueji/confirm/',v.confirm,name='confirm'),path('xueji/result/',v.result,name='result'),
    path('xueji/health/',v.health,name='health'),path('xueji/admin/',admin.site.urls),
    path('xueji/manage/',v.dashboard,name='dashboard'),path('xueji/manage/import/',v.import_students,name='import'),
    path('xueji/progress/',v.pending_classes,name='pending_classes'),
    path('xueji/progress/benbu/',v.pending_classes,{'group':'benbu'},name='pending_head_campus'),
    path('xueji/manage/batch/<int:pk>/',v.batch_action,name='batch_action'),
    path('xueji/manage/student/<uuid:pk>/',v.student_detail,name='student_detail'),
    path('xueji/manage/export/<int:pk>/<str:kind>/',v.export,name='export'),
    path('xueji/manage/qr/',v.qr,name='qr'),path('xueji/manage/template/',v.template_download,name='template'),
]
