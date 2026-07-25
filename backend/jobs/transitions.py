"""
The job state machine.

One map, enforced server-side and mirrored by the UI, so an illegal transition
is *unreachable* rather than merely rejected. Full rationale in
docs/OPEN_QUESTIONS.md Q7.
"""

from .models import StatusType


class TransitionError(Exception):
    """A status change the state machine does not permit."""


#: What each state may move to. A job that finished does not un-finish: a retry
#: is a new attempt, not a backwards edit of the old one.
ALLOWED: dict[str, set[str]] = {
    StatusType.PENDING: {StatusType.RUNNING, StatusType.FAILED},
    StatusType.RUNNING: {StatusType.COMPLETED, StatusType.FAILED},
    StatusType.COMPLETED: set(),  # terminal — done is done
    StatusType.FAILED: set(),  # terminal, but retryable below
}

#: Re-run is the only way out of a terminal state, and only from FAILED.
#: You retry a failure; re-running a success is a new job, not a resurrection.
RETRYABLE: set[str] = {StatusType.FAILED}

#: Where a re-run lands: back at the start of the lifecycle.
RETRY_TARGET = StatusType.PENDING


def is_terminal(status: str) -> bool:
    return not ALLOWED[status]


def can_retry(status: str) -> bool:
    return status in RETRYABLE


def allowed_from(status: str) -> set[str]:
    """States reachable from `status` by an ordinary transition.

    The UI uses this to disable options rather than let a user pick something
    the server will reject (TEST_PLAN case C12).
    """
    return set(ALLOWED[status])


def check(current: str, target: str) -> None:
    """Raise `TransitionError` unless `current → target` is permitted.

    Callers must handle the same-status case *before* calling this: re-applying
    the current status is an idempotent no-op, not an invalid transition
    (OPEN_QUESTIONS Q8). The map has no self-edges, so this would reject it.
    """
    if target not in ALLOWED[current]:
        if is_terminal(current):
            hint = (
                " Re-run it to start again."
                if can_retry(current)
                else " A completed job cannot be changed; create a new job instead."
            )
            raise TransitionError(f"{current} is a terminal state.{hint}")
        legal = ", ".join(sorted(ALLOWED[current]))
        raise TransitionError(f"Cannot move from {current} to {target}. Allowed: {legal}.")


def check_retry(current: str) -> None:
    """Raise `TransitionError` unless `current` may be re-run."""
    if not can_retry(current):
        if is_terminal(current):
            raise TransitionError(
                f"{current} jobs cannot be re-run — re-running a success is a new job, "
                "not a retry."
            )
        raise TransitionError(f"Only failed jobs can be re-run; this one is {current}.")
