from django.contrib import admin
from django.urls import path
from delaycheck import views
urlpatterns=[path('yanchi/',views.login,name='login'),path('yanchi/captcha/',views.captcha,name='captcha'),path('yanchi/logout/',views.logout,name='logout'),path('yanchi/check/',views.check,name='check'),path('yanchi/result/',views.result,name='result'),path('yanchi/progress/',views.progress,name='progress'),path('yanchi/progress/export/',views.progress_export,name='progress_export'),path('yanchi/health/',views.health,name='health'),path('yanchi/admin/',admin.site.urls)]
