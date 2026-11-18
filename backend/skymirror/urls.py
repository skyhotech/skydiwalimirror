from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView

from mirrors.urls import api_urlpatterns, dashboard_urlpatterns
from mirrors.views import customer_media

urlpatterns = [
    path("", RedirectView.as_view(url="/sky/mirror/admin/")),
    path("sky/mirror/admin/", include(dashboard_urlpatterns)),
    path("api/", include(api_urlpatterns)),
    path("media/customers/<path:filename>", customer_media, name="customer-media"),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Django's built-in admin has no sign-in lockout; production turns it off and
# staff use the dashboard at /sky/mirror/admin/ instead.
if settings.DJANGO_ADMIN_ENABLED:
    urlpatterns.append(path("django-admin/", admin.site.urls))
