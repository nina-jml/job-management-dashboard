"""Slice 1 API coverage — the list endpoint and the shared error shape."""

import pytest
from rest_framework.test import APIClient

from jobs.models import StatusType
from jobs.services import create_job, record_status

pytestmark = pytest.mark.django_db


@pytest.fixture
def client() -> APIClient:
    return APIClient()


def test_list_returns_a_cursor_envelope_without_a_count(client):
    create_job("Fluid Dynamics Simulation")

    body = client.get("/api/jobs/").json()

    assert set(body) == {"next", "previous", "results"}
    # A `count` would mean a COUNT(*) per page load — see jobs/pagination.py.
    assert "count" not in body


def test_list_serves_current_status_from_the_projection(client):
    job = create_job("ML Model Training")
    record_status(job, StatusType.RUNNING)

    result = client.get("/api/jobs/").json()["results"][0]

    assert result["name"] == "ML Model Training"
    assert result["current_status"] == StatusType.RUNNING
    assert set(result) == {
        "id",
        "name",
        "current_status",
        "current_status_at",
        "created_at",
        "updated_at",
        # Slice 3: lets the UI disable illegal options rather than let a user
        # pick something the server will reject.
        "allowed_transitions",
        "can_retry",
    }
    # `status` is write-only — an instruction to append to the log, not a field.
    assert "status" not in result


def test_pages_are_disjoint_and_ordered_newest_first(client):
    for index in range(5):
        create_job(f"Job {index}")

    first = client.get("/api/jobs/?page_size=2").json()
    assert len(first["results"]) == 2
    assert first["next"]

    second = client.get(first["next"]).json()

    first_ids = {job["id"] for job in first["results"]}
    second_ids = {job["id"] for job in second["results"]}
    assert first_ids.isdisjoint(second_ids)
    # Newest first, so the later-created ids come first.
    assert min(first_ids) > max(second_ids)


def test_page_size_is_capped(client):
    for index in range(3):
        create_job(f"Job {index}")

    body = client.get("/api/jobs/?page_size=100000").json()

    assert len(body["results"]) <= 100


def test_errors_use_one_shape_everywhere(client):
    response = client.get("/api/jobs/99999999/")

    assert response.status_code == 404
    assert response.json() == {"detail": "No Job matches the given query.", "errors": {}}


def test_health_reports_database_connectivity(client):
    response = client.get("/api/health/")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}
