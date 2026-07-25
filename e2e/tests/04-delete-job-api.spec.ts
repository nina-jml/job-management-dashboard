import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { history, uniquePrefix, type Job } from "./helpers";

/**
 * Slice 4 — DELETE /api/jobs/<id>/ and the status history endpoint.
 *
 * TEST_PLAN cases D1 (delete persists), D2 (history unreachable after delete),
 * D4 (404 for an unknown id).
 *
 * D3 — that no *orphan* JobStatus rows survive — is deliberately a backend unit
 * test, not an E2E one. The nested `.../statuses/` route 404s on the parent
 * lookup, so a job whose children were orphaned rather than deleted would return
 * a byte-identical 404. Telling those apart needs direct database access.
 */

async function createJob(request: APIRequestContext, label: string): Promise<Job> {
  const response = await request.post("/api/jobs/", {
    data: { name: `${uniquePrefix(label)}job` },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Job>;
}

test.describe("DELETE /api/jobs/<id>/", () => {
  test("deletes a job and it stays deleted (D1)", async ({ request }) => {
    const job = await createJob(request, "d1");

    const response = await request.delete(`/api/jobs/${job.id}/`);
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe("");

    // Gone from the detail route and from the list, not merely hidden.
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(404);

    const list = await request.get("/api/jobs/?page_size=100");
    const ids = ((await list.json()) as { results: Job[] }).results.map((j) => j.id);
    expect(ids).not.toContain(job.id);
  });

  test("the status history is unreachable afterwards (D2)", async ({ request }) => {
    const job = await createJob(request, "d2");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });

    // Present and populated before the delete.
    const before = await history(request, job.id);
    expect(before.results).toHaveLength(2);

    expect((await request.delete(`/api/jobs/${job.id}/`)).status()).toBe(204);

    expect((await request.get(`/api/jobs/${job.id}/statuses/`)).status()).toBe(404);
  });

  test("returns 404 for a job that does not exist (D4)", async ({ request }) => {
    const response = await request.delete("/api/jobs/99999999/");

    expect(response.status()).toBe(404);
    expect(await response.json()).toHaveProperty("detail");
  });

  test("deleting twice returns 404 the second time (D4)", async ({ request }) => {
    const job = await createJob(request, "d4b");

    expect((await request.delete(`/api/jobs/${job.id}/`)).status()).toBe(204);
    expect((await request.delete(`/api/jobs/${job.id}/`)).status()).toBe(404);
  });

  test("deleting one job leaves its neighbours untouched", async ({ request }) => {
    const keep = await createJob(request, "d-keep");
    const drop = await createJob(request, "d-drop");

    expect((await request.delete(`/api/jobs/${drop.id}/`)).status()).toBe(204);

    const survivor = await request.get(`/api/jobs/${keep.id}/`);
    expect(survivor.status()).toBe(200);
    expect((await history(request, keep.id)).results).toHaveLength(1);
  });
});

test.describe("GET /api/jobs/<id>/statuses/", () => {
  test("a new job has exactly one PENDING entry", async ({ request }) => {
    const job = await createJob(request, "h1");

    const { results } = await history(request, job.id);

    expect(results).toHaveLength(1);
    expect(results[0]!.status_type).toBe("PENDING");
  });

  test("the log is append-only — earlier entries survive a change", async ({ request }) => {
    const job = await createJob(request, "h2");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "COMPLETED" } });

    const { results } = await history(request, job.id);

    // Newest first, and nothing was overwritten on the way.
    expect(results.map((entry) => entry.status_type)).toEqual([
      "COMPLETED",
      "RUNNING",
      "PENDING",
    ]);
  });

  test("a re-run keeps the failure on the record", async ({ request }) => {
    const job = await createJob(request, "h3");
    for (const status of ["RUNNING", "FAILED", "PENDING"] as const) {
      expect((await request.patch(`/api/jobs/${job.id}/`, { data: { status } })).status()).toBe(200);
    }

    const { results } = await history(request, job.id);

    expect(results.map((entry) => entry.status_type)).toEqual([
      "PENDING",
      "FAILED",
      "RUNNING",
      "PENDING",
    ]);
  });

  test("an idempotent no-op appends nothing (C6)", async ({ request }) => {
    const job = await createJob(request, "h4");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });
    const before = (await history(request, job.id)).results.length;

    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });

    expect((await history(request, job.id)).results).toHaveLength(before);
  });

  test("a rename appends nothing (C10)", async ({ request }) => {
    const job = await createJob(request, "h5");
    const before = (await history(request, job.id)).results.length;

    await request.patch(`/api/jobs/${job.id}/`, { data: { name: `${uniquePrefix("h5")}new` } });

    expect((await history(request, job.id)).results).toHaveLength(before);
  });

  test("a rejected transition appends nothing (C3)", async ({ request }) => {
    const job = await createJob(request, "h6");
    for (const status of ["RUNNING", "COMPLETED"] as const) {
      await request.patch(`/api/jobs/${job.id}/`, { data: { status } });
    }
    const before = (await history(request, job.id)).results.length;

    const rejected = await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });
    expect(rejected.status()).toBe(400);

    expect((await history(request, job.id)).results).toHaveLength(before);
  });

  test("entries carry an id, a status and a timestamp", async ({ request }) => {
    const job = await createJob(request, "h7");

    const entry = (await history(request, job.id)).results[0]!;

    expect(Object.keys(entry).sort()).toEqual(["id", "status_type", "timestamp"]);
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  test("history is cursor-paginated like the job list", async ({ request }) => {
    const job = await createJob(request, "h8");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });

    const response = await request.get(`/api/jobs/${job.id}/statuses/?page_size=1`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { results: unknown[]; next: string | null };
    expect(body.results).toHaveLength(1);
    expect(body.next).not.toBeNull();
    // No COUNT(*) on this path either.
    expect(body).not.toHaveProperty("count");
  });

  test("returns 404 for a job that does not exist", async ({ request }) => {
    const response = await request.get("/api/jobs/99999999/statuses/");

    expect(response.status()).toBe(404);
  });
});
