"""
The state machine, exercised directly.

The E2E specs prove the API enforces these rules; these prove the map itself is
coherent, including the properties that are awkward to assert over HTTP.
"""

import pytest

from jobs import transitions
from jobs.models import StatusType
from jobs.services import apply_status_change, create_job
from jobs.transitions import TransitionError

pytestmark = pytest.mark.django_db


def advance(job, *steps):
    for step in steps:
        apply_status_change(job, step)
        job.refresh_from_db()
    return job


# --- the map itself ---------------------------------------------------------


def test_every_status_appears_in_the_map():
    # A new StatusType without a transition rule would raise KeyError at
    # runtime, on a request, rather than here.
    assert set(transitions.ALLOWED) == set(StatusType.values)


def test_transitions_only_target_real_statuses():
    for targets in transitions.ALLOWED.values():
        assert targets <= set(StatusType.values)


def test_the_map_has_no_self_edges():
    # Re-applying the current status is handled as an idempotent no-op before
    # the map is consulted (OPEN_QUESTIONS Q8); a self-edge would mask that.
    for status, targets in transitions.ALLOWED.items():
        assert status not in targets


def test_terminal_states_are_exactly_completed_and_failed():
    terminal = {s for s in StatusType.values if transitions.is_terminal(s)}
    assert terminal == {StatusType.COMPLETED, StatusType.FAILED}


def test_only_failed_is_retryable():
    # You retry a failure; re-running a success is a new job.
    assert transitions.RETRYABLE == {StatusType.FAILED}
    assert not transitions.can_retry(StatusType.COMPLETED)


def test_every_state_is_reachable_from_pending():
    # Strictness must not strand a state: walking the graph (including re-run)
    # has to reach all four, or the prompt's "any of the defined states" fails.
    seen, frontier = {StatusType.PENDING}, [StatusType.PENDING]
    while frontier:
        current = frontier.pop()
        nxt = set(transitions.ALLOWED[current])
        if transitions.can_retry(current):
            nxt.add(transitions.RETRY_TARGET)
        for target in nxt - seen:
            seen.add(target)
            frontier.append(target)
    assert seen == set(StatusType.values)


# --- enforcement ------------------------------------------------------------


def test_check_allows_a_legal_transition():
    transitions.check(StatusType.PENDING, StatusType.RUNNING)  # does not raise


def test_check_rejects_skipping_running():
    with pytest.raises(TransitionError, match="Cannot move from PENDING to COMPLETED"):
        transitions.check(StatusType.PENDING, StatusType.COMPLETED)


def test_check_rejects_leaving_a_terminal_state():
    with pytest.raises(TransitionError, match="terminal"):
        transitions.check(StatusType.COMPLETED, StatusType.RUNNING)


def test_a_failed_job_is_told_it_can_be_re_run():
    with pytest.raises(TransitionError, match="Re-run"):
        transitions.check(StatusType.FAILED, StatusType.RUNNING)


def test_a_completed_job_is_told_a_re_run_would_be_a_new_job():
    with pytest.raises(TransitionError, match="a new job, not a retry"):
        transitions.check_retry(StatusType.COMPLETED)


def test_a_running_job_is_told_re_run_does_not_apply_yet():
    with pytest.raises(TransitionError, match="Only failed jobs can be re-run"):
        transitions.check_retry(StatusType.RUNNING)


# --- the service ------------------------------------------------------------


def test_apply_status_change_appends_and_advances():
    job = create_job("Rotor Blade Modal Analysis")

    apply_status_change(job, StatusType.RUNNING)

    job.refresh_from_db()
    assert job.current_status == StatusType.RUNNING
    assert job.statuses.count() == 2


def test_same_status_is_a_no_op_that_appends_nothing():
    job = advance(create_job("Thermal Analysis"), StatusType.RUNNING)
    before_count = job.statuses.count()
    before_at = job.current_status_at

    assert apply_status_change(job, StatusType.RUNNING) is None

    job.refresh_from_db()
    assert job.statuses.count() == before_count
    assert job.current_status_at == before_at


def test_a_rejected_transition_leaves_the_log_untouched():
    job = advance(create_job("Crash Simulation"), StatusType.RUNNING, StatusType.COMPLETED)
    before = job.statuses.count()

    with pytest.raises(TransitionError):
        apply_status_change(job, StatusType.RUNNING)

    job.refresh_from_db()
    assert job.statuses.count() == before
    assert job.current_status == StatusType.COMPLETED


def test_re_run_appends_pending_and_keeps_the_failure_in_the_log():
    job = advance(create_job("Combustion Benchmark"), StatusType.RUNNING, StatusType.FAILED)

    apply_status_change(job, StatusType.PENDING)

    job.refresh_from_db()
    assert job.current_status == StatusType.PENDING
    # The log is append-only: the failure is still on the record.
    assert job.statuses.filter(status_type=StatusType.FAILED).exists()
    assert job.statuses.count() == 4


def test_a_completed_job_cannot_be_re_run():
    job = advance(create_job("Seismic Solve"), StatusType.RUNNING, StatusType.COMPLETED)

    with pytest.raises(TransitionError):
        apply_status_change(job, StatusType.PENDING)

    job.refresh_from_db()
    assert job.current_status == StatusType.COMPLETED
