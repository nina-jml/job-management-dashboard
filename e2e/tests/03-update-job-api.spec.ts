import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { history, uniquePrefix, type Job, type StatusType } from "./helpers";

/**
 * Step 3 — PATCH /api/jobs/<id>/.
 *
 * The state machine (OPEN_QUESTIONS Q7) plus the projection guard. Cases C1,
 * C3–C8, C10, C11, C13.
 */

async function createJob(request: APIRequestContext, label: string): Promise<Job> {
  const response = await request.post("/api/jobs/", {
    data: { name: `${uniquePrefix(label)}job` },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Job>;
}

async function patch(request: APIRequestContext, id: number, data: Record<string, unknown>) {
  return request.patch(`/api/jobs/${id}/`, { data });
}

/** Walk a job to `target` through legal transitions only. */
async function advanceTo(
  request: APIRequestContext,
  job: Job,
  target: StatusType,
): Promise<Job> {
  const route: Record<string, StatusType[]> = {
    PENDING: [],
    RUNNING: ["RUNNING"],
    COMPLETED: ["RUNNING", "COMPLETED"],
    FAILED: ["RUNNING", "FAILED"],
    CANCELED: ["RUNNING", "CANCELED"],
  };
  let current = job;
  for (const step of route[target]!) {
    const response = await patch(request, job.id, { status: step });
    expect(response.status()).toBe(200);
    current = (await response.json()) as Job;
  }
  return current;
}

test.describe("PATCH /api/jobs/<id>/", () => {
  test("PENDING to RUNNING advances the projection and both timestamps (C1)", async ({
    request,
  }) => {
    const job = await createJob(request, "c1");
    expect(job.current_status).toBe("PENDING");

    const response = await patch(request, job.id, { status: "RUNNING" });
    expect(response.status()).toBe(200);

    const updated = (await response.json()) as Job;
    expect(updated.current_status).toBe("RUNNING");
    // Both move on a status change; C10 covers the case where they diverge.
    expect(Date.parse(updated.current_status_at)).toBeGreaterThan(
      Date.parse(job.current_status_at),
    );
    expect(Date.parse(updated.updated_at)).toBeGreaterThanOrEqual(Date.parse(job.updated_at));

    // Persisted, not just echoed.
    const refetched = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(refetched.current_status).toBe("RUNNING");
  });

  test("the whole lifecycle is reachable, ending terminal (C2)", async ({ request }) => {
    const job = await createJob(request, "c2");

    for (const step of ["RUNNING", "FAILED"] as const) {
      expect((await patch(request, job.id, { status: step })).status()).toBe(200);
    }
    // Re-run out of FAILED, then take the success branch.
    expect((await patch(request, job.id, { status: "PENDING" })).status()).toBe(200);
    for (const step of ["RUNNING", "COMPLETED"] as const) {
      expect((await patch(request, job.id, { status: step })).status()).toBe(200);
    }

    const final = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(final.current_status).toBe("COMPLETED");
    expect(final.allowed_transitions).toEqual([]);
    expect(final.can_retry).toBe(false);
  });

  test("rejects a backwards transition out of COMPLETED (C3)", async ({ request }) => {
    const job = await createJob(request, "c3");
    await advanceTo(request, job, "COMPLETED");

    const response = await patch(request, job.id, { status: "RUNNING" });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.errors).toHaveProperty("status");
    expect(body.detail.toLowerCase()).toContain("terminal");

    // The projection did not move.
    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(after.current_status).toBe("COMPLETED");
  });

  test("rejects skipping RUNNING on the way to COMPLETED (C4)", async ({ request }) => {
    const job = await createJob(request, "c4");

    const response = await patch(request, job.id, { status: "COMPLETED" });

    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("status");

    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(after.current_status).toBe("PENDING");
  });

  test("re-runs a failed job back to PENDING (C5)", async ({ request }) => {
    const job = await createJob(request, "c5");
    const failed = await advanceTo(request, job, "FAILED");
    expect(failed.can_retry).toBe(true);

    const response = await patch(request, job.id, { status: "PENDING" });
    expect(response.status()).toBe(200);

    const rerun = (await response.json()) as Job;
    expect(rerun.current_status).toBe("PENDING");
    expect(rerun.allowed_transitions).toEqual(["CANCELED", "FAILED", "RUNNING"]);
  });

  test("re-applying the current status is an idempotent no-op (C6)", async ({ request }) => {
    const job = await createJob(request, "c6");
    const running = (await (await patch(request, job.id, { status: "RUNNING" })).json()) as Job;

    // A double-click, or a retry after a dropped response, asked for the state
    // the job is already in. That is not a failure.
    const response = await patch(request, job.id, { status: "RUNNING" });
    expect(response.status()).toBe(200);

    const after = (await response.json()) as Job;
    expect(after.current_status).toBe("RUNNING");
    // Nothing appended, so the projection timestamp is untouched.
    expect(after.current_status_at).toBe(running.current_status_at);
  });

  test("rejects an unknown status value (C7)", async ({ request }) => {
    const job = await createJob(request, "c7");

    const response = await patch(request, job.id, { status: "NOT_A_STATUS" });

    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("status");

    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(after.current_status).toBe("PENDING");
  });

  test("returns 404 for a nonexistent job (C8)", async ({ request }) => {
    const response = await patch(request, 99999999, { status: "RUNNING" });

    expect(response.status()).toBe(404);
    expect(await response.json()).toHaveProperty("detail");
  });

  test("a rename moves updated_at but not current_status_at (C10)", async ({ request }) => {
    const job = await createJob(request, "c10");
    const renamed = `${uniquePrefix("c10")}renamed`;

    const response = await patch(request, job.id, { name: renamed });
    expect(response.status()).toBe(200);

    const after = (await response.json()) as Job;
    expect(after.name).toBe(renamed);
    expect(after.current_status).toBe("PENDING");
    // The divergence the projection guard depends on: any save bumps
    // updated_at, but only a status event moves current_status_at.
    expect(after.current_status_at).toBe(job.current_status_at);
    expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(job.updated_at));
  });

  test("a later status event still lands after a rename (C10 regression)", async ({ request }) => {
    // If the guard compared against updated_at, the rename above would push it
    // past the incoming event and the status change would be silently dropped.
    const job = await createJob(request, "c10b");
    await patch(request, job.id, { name: `${uniquePrefix("c10b")}renamed` });

    const response = await patch(request, job.id, { status: "RUNNING" });

    expect(response.status()).toBe(200);
    expect(((await response.json()) as Job).current_status).toBe("RUNNING");
  });

  test("a rename and a status change in one request both apply", async ({ request }) => {
    const job = await createJob(request, "both");
    const renamed = `${uniquePrefix("both")}renamed`;

    const response = await patch(request, job.id, { name: renamed, status: "RUNNING" });
    expect(response.status()).toBe(200);

    const after = (await response.json()) as Job;
    expect(after.name).toBe(renamed);
    expect(after.current_status).toBe("RUNNING");
  });

  test("concurrent status changes serialize without a lost update (C11)", async ({ request }) => {
    const job = await createJob(request, "c11");
    await patch(request, job.id, { status: "RUNNING" });

    // Both targets are legal from RUNNING, so whichever loses the race is
    // rejected by the state machine rather than corrupting the projection.
    const [a, b] = await Promise.all([
      patch(request, job.id, { status: "COMPLETED" }),
      patch(request, job.id, { status: "FAILED" }),
    ]);

    const statuses = [a.status(), b.status()].sort();
    expect(statuses[1]).toBe(400); // the second writer sees a terminal state
    expect(statuses[0]).toBe(200);

    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(["COMPLETED", "FAILED"]).toContain(after.current_status);
  });

  test("refuses to re-run a completed job (C13)", async ({ request }) => {
    const job = await createJob(request, "c13");
    await advanceTo(request, job, "COMPLETED");

    const response = await patch(request, job.id, { status: "PENDING" });

    expect(response.status()).toBe(400);
    // Done is done: re-running a success is a new job, not a resurrection.
    expect((await response.json()).errors).toHaveProperty("status");

    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(after.current_status).toBe("COMPLETED");
    expect(after.can_retry).toBe(false);
  });

  test("advertises the transitions the UI may offer (C12 backing data)", async ({ request }) => {
    const job = await createJob(request, "c12");
    expect(job.allowed_transitions).toEqual(["CANCELED", "FAILED", "RUNNING"]);
    expect(job.can_retry).toBe(false);

    const running = (await (await patch(request, job.id, { status: "RUNNING" })).json()) as Job;
    expect(running.allowed_transitions).toEqual(["CANCELED", "COMPLETED", "FAILED"]);

    const failed = (await (await patch(request, job.id, { status: "FAILED" })).json()) as Job;
    expect(failed.allowed_transitions).toEqual([]);
    expect(failed.can_retry).toBe(true);
  });

  test("PUT is not allowed — updates are partial by design", async ({ request }) => {
    const job = await createJob(request, "put");

    const response = await request.put(`/api/jobs/${job.id}/`, { data: { name: "x" } });

    expect(response.status()).toBe(405);
  });

  test("cancels a queued job before it ever starts (C14)", async ({ request }) => {
    const job = await createJob(request, "c14");

    const response = await patch(request, job.id, { status: "CANCELED" });
    expect(response.status()).toBe(200);

    const cancelled = (await response.json()) as Job;
    expect(cancelled.current_status).toBe("CANCELED");
    // Terminal, but the work never finished — so it can be re-run.
    expect(cancelled.allowed_transitions).toEqual([]);
    expect(cancelled.can_retry).toBe(true);
  });

  test("cancels a running job (C15)", async ({ request }) => {
    const job = await createJob(request, "c15");
    await patch(request, job.id, { status: "RUNNING" });

    const response = await patch(request, job.id, { status: "CANCELED" });
    expect(response.status()).toBe(200);
    expect(((await response.json()) as Job).current_status).toBe("CANCELED");
  });

  test("re-runs a cancelled job (C16)", async ({ request }) => {
    const job = await createJob(request, "c16");
    await advanceTo(request, job, "CANCELED");

    const response = await patch(request, job.id, { status: "PENDING" });
    expect(response.status()).toBe(200);

    const rerun = (await response.json()) as Job;
    expect(rerun.current_status).toBe("PENDING");

    // Append-only: the cancellation stays on the record. Cancelling is not
    // deleting — the job consumed compute time and that history survives.
    const { results } = await history(request, job.id);
    expect(results.map((entry) => entry.status_type)).toEqual([
      "PENDING",
      "CANCELED",
      "RUNNING",
      "PENDING",
    ]);
  });

  test("refuses to cancel a completed job (C17)", async ({ request }) => {
    const job = await createJob(request, "c17");
    await advanceTo(request, job, "COMPLETED");

    const response = await patch(request, job.id, { status: "CANCELED" });

    // Nothing left to stop.
    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("status");

    const after = (await (await request.get(`/api/jobs/${job.id}/`)).json()) as Job;
    expect(after.current_status).toBe("COMPLETED");
  });

  test("refuses to cancel a failed job (C17)", async ({ request }) => {
    const job = await createJob(request, "c17b");
    await advanceTo(request, job, "FAILED");

    // The job already stopped on its own; cancelling would rewrite why.
    expect((await patch(request, job.id, { status: "CANCELED" })).status()).toBe(400);
  });
});
