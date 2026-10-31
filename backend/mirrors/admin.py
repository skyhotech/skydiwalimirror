from django.contrib import admin

from .models import Customer, Mirror


@admin.register(Mirror)
class MirrorAdmin(admin.ModelAdmin):
    list_display = ["name", "slug", "is_active", "order", "updated_at"]
    list_editable = ["is_active", "order"]


@admin.register(Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ["__str__", "mirror_name", "reward", "phone", "created_at"]
    list_filter = ["mirror", "reward"]
