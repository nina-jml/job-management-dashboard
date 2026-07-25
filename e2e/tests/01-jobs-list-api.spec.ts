import { expect, test } from "@playwright/test";

import { JOB_FIELDS, listJobs, STATUS_TYPES, toPath, type Job, type Page } from "./helpers";

/**
 * Slice 1 — the list endpoint.
 *
 * TEST_PLAN cases E1 (payload carries name + current status) and E2 (newest
 * first, stable ordering). Runs against the seeded baseline that `make test`
 * creates, and asserts on structure and invariants rather than on specific
 * rows, so it stays valid as later slices add data.
 */
test.describe("GET /api/jobs/", () => {
  test("returns a cursor-paginated envelope", async ({ request }) => {
    const response = await request.get("/api/jobs/");
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Page<Job>;
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("next");
    expect(body).toHaveProperty("previous");
    expect(Array.isArray(body.results)).toBe(true);

    // Cursor pagination deliberately has no `count`: computing it means a
    // COUNT(*) on every page load, which is a full scan at the scale this
    // design targets. See jobs/pagination.py.
    expect(body).not.toHaveProperty("count");
  });

  test("every job carries its current status and timestamps (E1)", async ({ request }) => {
    const { results } = await listJobs(request, { page_size: 5 });
    expect(results.length).toBeGreaterThan(0);

    for (const job of results) {
      expect(Object.keys(job).sort()).toEqual([...JOB_FIELDS].sort());
      expect(typeof job.id).toBe("number");
      expect(job.name.length).toBeGreaterThan(0);
      expect(STATUS_TYPES).toContain(job.current_status);
      // A job with a status but no timestamp for it would mean the projection
      // was written outside record_status().
      expect(Number.isNaN(Date.parse(job.current_status_at))).toBe(false);
      expect(Number.isNaN(Date.parse(job.created_at))).toBe(false);
    }
  });

  test("orders newest first, with a total ordering (E2)", async ({ request }) => {
    const { results } = await listJobs(request, { page_size: 25 });
    expect(results.length).toBeGreaterThan(1);

    for (let i = 1; i < results.length; i += 1) {
      const previous = results[i - 1]!;
      const current = results[i]!;
      const gap = Date.parse(previous.created_at) - Date.parse(current.created_at);

      expect(gap).toBeGreaterThanOrEqual(0);
      // Ties must still be ordered, by descending id — that is what makes the
      // ordering total, and total ordering is what keyset pagination needs to
      // avoid skipping or repeating rows.
      if (gap === 0) expect(previous.id).toBeGreaterThan(current.id);
    }
  });

  test("ordering is stable across identical requests (E2)", async ({ request }) => {
    const first = await listJobs(request, { page_size: 10 });
    const second = await listJobs(request, { page_size: 10 });

    expect(second.results.map((job) => job.id)).toEqual(first.results.map((job) => job.id));
  });

  test("honours page_size and pages forward without overlap", async ({ request }) => {
    const first = await listJobs(request, { page_size: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.next).not.toBeNull();

    const response = await request.get(toPath(first.next!));
    expect(response.status()).toBe(200);
    const second = (await response.json()) as Page<Job>;

    const firstIds = first.results.map((job) => job.id);
    const secondIds = second.results.map((job) => job.id);

    // Disjoint pages: the defining property of a correct keyset walk.
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    expect(second.previous).not.toBeNull();
  });

  test("caps page_size so a client cannot ask for the whole table", async ({ request }) => {
    const { results } = await listJobs(request, { page_size: 5000 });

    // max_page_size = 100 in jobs/pagination.py.
    expect(results.length).toBeLessThanOrEqual(100);
  });

  test("retrieving a single job returns the same representation", async ({ request }) => {
    const { results } = await listJobs(request, { page_size: 1 });
    const job = results[0]!;

    const response = await request.get(`/api/jobs/${job.id}/`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(job);
  });

  test("an unknown job id returns a 404 in the standard error shape", async ({ request }) => {
    const response = await request.get("/api/jobs/99999999/");

    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("detail");
    expect(body).toHaveProperty("errors");
  });
});
