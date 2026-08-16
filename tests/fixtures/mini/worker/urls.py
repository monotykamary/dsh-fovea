from django.urls import path, re_path


def jobs_view(request):
    return None


def legacy_view(request, pk):
    return None


urlpatterns = [
    path("jobs/", jobs_view, name="jobs"),
    re_path(r"^legacy/(?P<pk>[0-9]+)/$", legacy_view),
]
