import { expect, test } from "@playwright/test";

import { listJobs, uniquePrefix, type Job } from "./helpers";

/**
 * Step 2 — POST /api/jobs/.
 *
 * TEST_PLAN cases B1 (create yields PENDING), B2/B3/B4 (name validation),
 * B6 (unicode and markup survive intact), B7 (duplicate names allowed).
 *
 * Every job is created under a run-unique prefix so the spec is safe to
 * re-run against a database it does not own (case A3).
 */
test.describe("POST /api/jobs/", () => {
  test("creates a job with an automatic PENDING status (B1)", async ({ request }) => {
    const name = `${uniquePrefix("create")}Fluid Dynamics Simulation`;

    const response = await request.post("/api/jobs/", { data: { name } });
    expect(response.status()).toBe(201);

    const job = (await response.json()) as Job;
    expect(job.name).toBe(name);
    expect(job.current_status).toBe("PENDING");
    expect(job.id).toBeGreaterThan(0);

    // A job must never exist without the status its projection reflects.
    expect(job.current_status_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(job.current_status_at))).toBe(false);
  });

  test("the new job appears in the list immediately (B1)", async ({ request }) => {
    const name = `${uniquePrefix("listed")}ML Model Training`;
    const created = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;

    // Newest first, so a just-created job heads the first page.
    const { results } = await listJobs(request, { page_size: 5 });

    const found = results.find((job) => job.id === created.id);
    expect(found).toBeDefined();
    expect(found!.current_status).toBe("PENDING");
  });

  test("rejects an empty name (B2)", async ({ request }) => {
    const response = await request.post("/api/jobs/", { data: { name: "" } });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.errors).toHaveProperty("name");
    expect(body.detail).toContain("name");
  });

  test("rejects a whitespace-only name (B3)", async ({ request }) => {
    // Trim-then-check: "   " is a blank name, not a three-character one.
    const response = await request.post("/api/jobs/", { data: { name: "   " } });

    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("name");
  });

  test("rejects a missing name field (B2)", async ({ request }) => {
    const response = await request.post("/api/jobs/", { data: {} });

    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("name");
  });

  test("rejects a name longer than 200 characters (B4)", async ({ request }) => {
    const response = await request.post("/api/jobs/", { data: { name: "x".repeat(201) } });

    expect(response.status()).toBe(400);
    expect((await response.json()).errors).toHaveProperty("name");
  });

  test("accepts a name of exactly 200 characters (B4 boundary)", async ({ request }) => {
    const prefix = uniquePrefix("max");
    const name = prefix + "x".repeat(200 - prefix.length);

    const response = await request.post("/api/jobs/", { data: { name } });

    expect(response.status()).toBe(201);
    expect(((await response.json()) as Job).name).toHaveLength(200);
  });

  test("stores unicode, emoji and markup verbatim (B6)", async ({ request }) => {
    // Round-tripping these unchanged is what proves nothing is silently
    // escaping or mangling job names server-side. The UI escapes on render.
    const name = `${uniquePrefix("unicode")}Δp «flow» 🔥 <script>alert(1)</script> "quoted" it's`;

    const created = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;
    expect(created.name).toBe(name);

    const fetched = (await (await request.get(`/api/jobs/${created.id}/`)).json()) as Job;
    expect(fetched.name).toBe(name);
  });

  test("trims surrounding whitespace from an otherwise valid name", async ({ request }) => {
    const name = `${uniquePrefix("trim")}Thermal Analysis`;

    const response = await request.post("/api/jobs/", { data: { name: `  ${name}  ` } });

    expect(response.status()).toBe(201);
    expect(((await response.json()) as Job).name).toBe(name);
  });

  test("allows two jobs with identical names (B7)", async ({ request }) => {
    // Real job names collide constantly; nothing in the prompt implies
    // uniqueness (OPEN_QUESTIONS A3).
    const name = `${uniquePrefix("dup")}Crash Simulation`;

    const first = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;
    const second = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;

    expect(first.id).not.toBe(second.id);
    expect(second.name).toBe(first.name);

    // Both remain independently addressable.
    expect((await request.get(`/api/jobs/${first.id}/`)).status()).toBe(200);
    expect((await request.get(`/api/jobs/${second.id}/`)).status()).toBe(200);
  });

  test("ignores client-supplied status and timestamps", async ({ request }) => {
    // These are read-only: status is owned by the log, timestamps by the
    // server (OPEN_QUESTIONS Q3).
    const name = `${uniquePrefix("readonly")}Seeded Fields`;

    const response = await request.post("/api/jobs/", {
      data: { name, current_status: "COMPLETED", created_at: "2000-01-01T00:00:00Z" },
    });

    expect(response.status()).toBe(201);
    const job = (await response.json()) as Job;
    expect(job.current_status).toBe("PENDING");
    expect(new Date(job.created_at).getFullYear()).toBeGreaterThan(2020);
  });
});
