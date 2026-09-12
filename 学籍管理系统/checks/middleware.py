from django.utils.cache import add_never_cache_headers
from django.conf import settings
from django.http import HttpResponseForbidden, HttpResponse

class PrivateMiddleware:
    def __init__(self, get_response): self.get_response = get_response
    def __call__(self, request):
        # Only Nginx or an SSH tunnel can reach the loopback-bound application port.
        if request.META.get('HTTP_X_REAL_IP'):
            request.META['REMOTE_ADDR'] = request.META['HTTP_X_REAL_IP']
        if settings.DEMO_MODE and request.path.startswith(('/xueji/admin/', '/xueji/manage/')):
            if request.META.get('HTTP_X_REAL_IP', '127.0.0.1') not in {'127.0.0.1','::1'}:
                return HttpResponseForbidden('演示管理后台仅通过 SSH 隧道访问。')
        if request.method == 'POST' and request.path == '/xueji/admin/login/':
            from .services import attempt
            if not attempt('admin:'+request.META.get('REMOTE_ADDR',''),10,300):
                return HttpResponse('尝试次数较多，请稍后重试。',status=429)
        response = self.get_response(request)
        if not request.path.startswith('/xueji/static/'):
            add_never_cache_headers(response)
            response['X-Robots-Tag'] = 'noindex, nofollow'
        response['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        response['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
        return response
