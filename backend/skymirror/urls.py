from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView

from mirrors.urls import api_urlpatterns, dashboard_urlpatterns

urlpatterns = [
    path("", RedirectView.as_view(url="/sky/mirror/admin/")),
    path("sky/mirror/admin/", include(dashboard_urlpatterns)),
    path("api/", include(api_urlpatterns)),
    path("django-admin/", admin.site.urls),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
