from rest_framework import serializers

from .models import Job, JobStatus, StatusType
from .services import apply_status_change, create_job
from .transitions import TransitionError, allowed_from, can_retry


class JobStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = JobStatus
        fields = ("id", "status_type", "timestamp")
        read_only_fields = fields


class JobSerializer(serializers.ModelSerializer):
    """Read representation of a job, plus a write-only `status` instruction.

    `current_status` is served straight from the projection column, so listing
    jobs touches exactly one table — no per-row subquery, no N+1.

    `status` is **not** a field on `Job`. It is an instruction to append to the
    log, which is why it is write-only: what comes back is `current_status`,
    the projection the append produced.
    """

    status = serializers.ChoiceField(
        choices=StatusType.choices,
        write_only=True,
        required=False,
        help_text="Move the job to this state. Appends a JobStatus event.",
    )
    # Lets the UI disable options rather than let a user pick something the
    # server will reject (TEST_PLAN case C12).
    allowed_transitions = serializers.SerializerMethodField()
    can_retry = serializers.SerializerMethodField()

    class Meta:
        model = Job
        fields = (
            "id",
            "name",
            "current_status",
            "current_status_at",
            "created_at",
            "updated_at",
            "status",
            "allowed_transitions",
            "can_retry",
        )
        read_only_fields = (
            "id",
            "current_status",
            "current_status_at",
            "created_at",
            "updated_at",
        )

    def get_allowed_transitions(self, job: Job) -> list[str]:
        return sorted(allowed_from(job.current_status))

    def get_can_retry(self, job: Job) -> bool:
        return can_retry(job.current_status)

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
        validated_data.pop("status", None)  # creation always starts at PENDING
        return create_job(name=validated_data["name"])

    def update(self, instance: Job, validated_data: dict) -> Job:
        target = validated_data.pop("status", None)

        # A rename is an ordinary save. It moves `updated_at` but must not touch
        # `current_status_at` — that divergence is exactly what the projection
        # guard depends on (TEST_PLAN case C10).
        if "name" in validated_data:
            instance.name = validated_data["name"]
            instance.save(update_fields=["name", "updated_at"])

        if target is not None:
            try:
                apply_status_change(instance, target)
            except TransitionError as exc:
                # A rejected transition is a validation failure on `status`, so
                # it lands in the same {detail, errors} shape as every other 400.
                raise serializers.ValidationError({"status": [str(exc)]}) from exc
            instance.refresh_from_db()

        return instance
