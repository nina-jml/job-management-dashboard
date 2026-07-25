import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import {
  JOB_FIELDS,
  listJobs,
  STATUS_TYPES,
  toPath,
  uniquePrefix,
  type Job,
  type Page,
} from "./helpers";

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

/**
 * `?status=` repeats to select several at once. The suite shares a database
 * with seeded rows, so these assert two things that hold regardless of what
 * else is in the table: every row returned matches the filter, and the
 * fixtures this spec created are among them.
 */
test.describe("GET /api/jobs/?status=", () => {
  async function fixtures(request: APIRequestContext, label: string) {
    const prefix = uniquePrefix(label);
    const made: Record<string, Job> = {};

    for (const status of ["PENDING", "RUNNING", "FAILED"] as const) {
      const job = (await (
        await request.post("/api/jobs/", { data: { name: `${prefix}${status}` } })
      ).json()) as Job;
      // PENDING is where a job starts, so only the other two need moving.
      if (status !== "PENDING") {
        await request.patch(`/api/jobs/${job.id}/`, { data: { status } });
      }
      made[status] = job;
    }

    return made;
  }

  test("a single status narrows to that status", async ({ request }) => {
    const made = await fixtures(request, "api-one");

    const response = await request.get("/api/jobs/?status=RUNNING&page_size=100");
    expect(response.status()).toBe(200);
    const { results } = (await response.json()) as Page<Job>;

    expect(results.every((job) => job.current_status === "RUNNING")).toBe(true);
    expect(results.map((job) => job.id)).toContain(made.RUNNING!.id);
  });

  test("repeating the parameter returns the union", async ({ request }) => {
    const made = await fixtures(request, "api-many");

    const response = await request.get("/api/jobs/?status=RUNNING&status=FAILED&page_size=100");
    expect(response.status()).toBe(200);
    const { results } = (await response.json()) as Page<Job>;

    const ids = results.map((job) => job.id);
    expect(ids).toContain(made.RUNNING!.id);
    expect(ids).toContain(made.FAILED!.id);
    // A union, not a widening: the third fixture must not come back.
    expect(ids).not.toContain(made.PENDING!.id);
    expect(results.every((job) => ["RUNNING", "FAILED"].includes(job.current_status))).toBe(true);
  });

  test("a repeated value behaves like selecting it once", async ({ request }) => {
    const made = await fixtures(request, "api-dupe");

    const response = await request.get("/api/jobs/?status=FAILED&status=FAILED&page_size=100");
    expect(response.status()).toBe(200);
    const { results } = (await response.json()) as Page<Job>;

    expect(results.every((job) => job.current_status === "FAILED")).toBe(true);
    expect(results.map((job) => job.id)).toContain(made.FAILED!.id);
  });

  test("an empty value is no filter rather than no results", async ({ request }) => {
    const made = await fixtures(request, "api-empty");

    const response = await request.get("/api/jobs/?status=&page_size=100");
    expect(response.status()).toBe(200);
    const { results } = (await response.json()) as Page<Job>;

    // The PENDING fixture would be excluded by any real filter.
    expect(results.map((job) => job.id)).toContain(made.PENDING!.id);
  });

  test("an unknown status is a 400, not an empty list", async ({ request }) => {
    const response = await request.get("/api/jobs/?status=BANANA");

    // Returning nothing would read as "no jobs match" and send the caller
    // looking for missing data instead of a typo.
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { detail: string; errors: Record<string, string[]> };
    expect(body).toHaveProperty("detail");
    expect(body.errors.status!.join(" ")).toContain("BANANA");
  });

  test("one bad value among good ones still fails, and names it", async ({ request }) => {
    const response = await request.get("/api/jobs/?status=RUNNING&status=BANANA");

    expect(response.status()).toBe(400);
    const body = (await response.json()) as { errors: Record<string, string[]> };
    const message = body.errors.status!.join(" ");
    expect(message).toContain("BANANA");
    // The valid one is not the problem and must not be reported as one.
    expect(message).not.toContain("RUNNING");
  });
});
