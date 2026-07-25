from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import JobViewSet, health

router = DefaultRouter()
router.register(r"jobs", JobViewSet, basename="job")

urlpatterns = [
    path("health/", health, name="health"),
    path("", include(router.urls)),
]
