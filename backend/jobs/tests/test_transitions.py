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


def test_terminal_states_are_the_three_finished_ones():
    terminal = {s for s in StatusType.values if transitions.is_terminal(s)}
    assert terminal == {StatusType.COMPLETED, StatusType.FAILED, StatusType.CANCELLED}


def test_only_unfinished_work_is_retryable():
    # You retry a failure or a cancellation — work that did not finish.
    # Re-running a success is a new job.
    assert transitions.RETRYABLE == {StatusType.FAILED, StatusType.CANCELLED}
    assert not transitions.can_retry(StatusType.COMPLETED)


def test_every_retryable_state_is_terminal():
    # Retry is the escape hatch from terminal states; a retryable state that
    # still had ordinary transitions would give two ways out of one place.
    for status in transitions.RETRYABLE:
        assert transitions.is_terminal(status)


def test_cancellation_is_reachable_from_unfinished_states_only():
    # You can call off queued or running work; there is nothing left to stop
    # once a job has completed or failed.
    for status in (StatusType.PENDING, StatusType.RUNNING):
        assert StatusType.CANCELLED in transitions.ALLOWED[status]
    for status in (StatusType.COMPLETED, StatusType.FAILED):
        assert StatusType.CANCELLED not in transitions.ALLOWED[status]


def test_every_state_is_reachable_from_pending():
    # Strictness must not strand a state: walking the graph (including re-run)
    # has to reach every one, or the prompt's "any of the defined states" fails.
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
    # The message enumerates RETRYABLE, so it stays accurate as states are added.
    with pytest.raises(TransitionError, match="Only cancelled or failed jobs can be re-run"):
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


# --- cancellation -----------------------------------------------------------


def test_a_queued_job_can_be_cancelled_before_it_starts():
    job = create_job("Turbine Disc Creep")

    apply_status_change(job, StatusType.CANCELLED)

    job.refresh_from_db()
    assert job.current_status == StatusType.CANCELLED
    assert job.statuses.count() == 2


def test_a_running_job_can_be_cancelled():
    job = advance(create_job("Multiphase Separator CFD"), StatusType.RUNNING)

    apply_status_change(job, StatusType.CANCELLED)

    job.refresh_from_db()
    assert job.current_status == StatusType.CANCELLED


def test_a_cancelled_job_can_be_re_run():
    job = advance(create_job("Aeroacoustic Propagation"), StatusType.RUNNING, StatusType.CANCELLED)

    apply_status_change(job, StatusType.PENDING)

    job.refresh_from_db()
    assert job.current_status == StatusType.PENDING
    # Append-only: the cancellation stays on the record. A cancelled job still
    # consumed compute time, and that is the history worth auditing.
    assert job.statuses.filter(status_type=StatusType.CANCELLED).exists()


def test_a_completed_job_cannot_be_cancelled():
    job = advance(create_job("CFD Mesh Convergence"), StatusType.RUNNING, StatusType.COMPLETED)

    with pytest.raises(TransitionError):
        apply_status_change(job, StatusType.CANCELLED)

    job.refresh_from_db()
    assert job.current_status == StatusType.COMPLETED


def test_a_failed_job_cannot_be_cancelled():
    # Nothing left to stop — the job already stopped on its own.
    job = advance(create_job("Battery Thermal Runaway"), StatusType.RUNNING, StatusType.FAILED)

    with pytest.raises(TransitionError):
        apply_status_change(job, StatusType.CANCELLED)


def test_cancelling_twice_is_an_idempotent_no_op():
    job = advance(create_job("Crash Pulse"), StatusType.RUNNING, StatusType.CANCELLED)
    before = job.statuses.count()

    assert apply_status_change(job, StatusType.CANCELLED) is None

    job.refresh_from_db()
    assert job.statuses.count() == before
