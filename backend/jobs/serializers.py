from rest_framework import serializers

from .models import Job, JobStatus
from .services import create_job


class JobStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = JobStatus
        fields = ("id", "status_type", "timestamp")
        read_only_fields = fields


class JobSerializer(serializers.ModelSerializer):
    """Read representation of a job, including its current status.

    `current_status` is served straight from the projection column, so listing
    jobs touches exactly one table — no per-row subquery, no N+1.
    """

    class Meta:
        model = Job
        fields = (
            "id",
            "name",
            "current_status",
            "current_status_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "current_status",
            "current_status_at",
            "created_at",
            "updated_at",
        )

    def validate_name(self, value: str) -> str:
        # Trim first, then check: "   " is a blank name, not a valid one
        # (TEST_PLAN case B3).
        name = value.strip()
        if not name:
            raise serializers.ValidationError("This field may not be blank.")
        return name

    def create(self, validated_data: dict) -> Job:
        # Routed through the service so the job and its initial PENDING status
        # are written in one transaction. A job must never exist with an empty
        # log, or `current_status` would be a projection of nothing.
        return create_job(name=validated_data["name"])
