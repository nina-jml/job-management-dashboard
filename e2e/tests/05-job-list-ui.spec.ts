import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { uniquePrefix, type Job } from "./helpers";

/**
 * Slice 5 — the job list.
 *
 * TEST_PLAN cases E1 (rows show name and current status), E3 (empty state),
 * E6 (history timeline). Error paths are built here too but swept
 * systematically in slice 9.
 */

const row = (page: Page, id: number) => page.locator(`[data-job-id="${id}"]`);

test.describe("job list", () => {
  test("renders each job with its name and current status (E1)", async ({ page, request }) => {
    const name = `${uniquePrefix("e1")}Fluid Dynamics Simulation`;
    const job = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;

    await page.goto("/");

    const target = row(page, job.id);
    await expect(target).toBeVisible();
    await expect(target.getByText(name, { exact: true })).toBeVisible();
    // The badge spells the state out; colour is never the only carrier.
    await expect(target.locator(".status")).toHaveText(/Pending/);
    await expect(target).toHaveAttribute("data-status", "PENDING");
  });

  test("shows the job id in its own column", async ({ page, request }) => {
    const name = `${uniquePrefix("id")}Job`;
    const job = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;

    await page.goto("/");

    // Zero-padded so the column keeps one width.
    await expect(row(page, job.id).locator(".job-id")).toHaveText(
      `#${String(job.id).padStart(7, "0")}`,
    );
  });

  test("matches the API payload exactly (E1)", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator(".rows .row").first()).toBeVisible();

    const { results } = (await (await request.get("/api/jobs/?page_size=25")).json()) as {
      results: Job[];
    };

    // Same order, same statuses — the list is not reordering or recolouring.
    const rendered = await page.locator(".rows .row").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: Number(node.getAttribute("data-job-id")),
        status: node.getAttribute("data-status"),
      })),
    );
    expect(rendered.slice(0, results.length)).toEqual(
      results.map((job) => ({ id: job.id, status: job.current_status })),
    );
  });

  test("renders an empty state, not a spinner or a blank page (E3)", async ({ page }) => {
    await page.route("**/api/jobs/?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ next: null, previous: null, results: [] }),
      }),
    );

    await page.goto("/");

    await expect(page.getByText("No jobs yet")).toBeVisible();
    await expect(page.locator(".rows .row")).toHaveCount(0);
  });

  test("expands a job's status history (E6)", async ({ page, request }) => {
    const name = `${uniquePrefix("e6")}Timeline Fixture`;
    const job = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });

    await page.goto("/");
    await row(page, job.id).getByRole("button", { name: /status history/i }).click();

    const timeline = page.locator(".history");
    await expect(timeline).toBeVisible();
    await expect(timeline.getByText("2 entries")).toBeVisible();
    // Newest first, and the earlier entry survived — the log is append-only.
    await expect(timeline.locator("li b").first()).toHaveText("Running");
    await expect(timeline.locator("li b").last()).toHaveText("Pending");
  });

  test("collapses the history again", async ({ page, request }) => {
    const name = `${uniquePrefix("e6b")}Toggle Fixture`;
    const job = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;

    await page.goto("/");
    const toggle = row(page, job.id).getByRole("button", { name: /status history/i });

    await toggle.click();
    await expect(page.locator(".history")).toBeVisible();
    await toggle.click();
    await expect(page.locator(".history")).toHaveCount(0);
  });

  test("filters by status server-side (E3 backing)", async ({ page, request }) => {
    const name = `${uniquePrefix("filter")}Filterable`;
    const job = (await (await request.post("/api/jobs/", { data: { name } })).json()) as Job;
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });

    await page.goto("/");

    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/jobs/?")) requests.push(req.url());
    });

    await page.getByRole("button", { name: "Running", exact: true }).click();
    await expect(row(page, job.id)).toBeVisible();

    // A round trip, not a client-side narrowing of loaded rows.
    expect(requests.some((url) => url.includes("status=RUNNING"))).toBe(true);
    const statuses = await page
      .locator(".rows .row")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-status")));
    expect(new Set(statuses)).toEqual(new Set(["RUNNING"]));
  });

  test("selects several statuses at once", async ({ page, request }) => {
    const prefix = uniquePrefix("multi");
    // One job per state, so a filter that quietly returned everything and a
    // filter that returned the right union would look different.
    const running = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Running` } })
    ).json()) as Job;
    const failed = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Failed` } })
    ).json()) as Job;
    const pending = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Pending` } })
    ).json()) as Job;

    await request.patch(`/api/jobs/${running.id}/`, { data: { status: "RUNNING" } });
    await request.patch(`/api/jobs/${failed.id}/`, { data: { status: "FAILED" } });

    await page.goto("/");

    const requests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/jobs/?")) requests.push(req.url());
    });

    await page.getByRole("button", { name: "Running", exact: true }).click();
    await page.getByRole("button", { name: "Failed", exact: true }).click();

    await expect(row(page, running.id)).toBeVisible();
    await expect(row(page, failed.id)).toBeVisible();
    // The point of the case: the third job is excluded, so this is a union of
    // two states and not simply an unfiltered list.
    await expect(row(page, pending.id)).toHaveCount(0);

    // Repeated parameters, one per selection — the shape the server reads.
    expect(
      requests.some((url) => url.includes("status=RUNNING") && url.includes("status=FAILED")),
    ).toBe(true);

    const statuses = await page
      .locator(".rows .row")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-status")));
    expect(new Set(statuses)).toEqual(new Set(["RUNNING", "FAILED"]));
  });

  test("deselects a status, and the last one clears back to All", async ({ page, request }) => {
    const prefix = uniquePrefix("deselect");
    const running = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Running` } })
    ).json()) as Job;
    const pending = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Pending` } })
    ).json()) as Job;
    await request.patch(`/api/jobs/${running.id}/`, { data: { status: "RUNNING" } });

    await page.goto("/");

    const runningChip = page.getByRole("button", { name: "Running", exact: true });
    const allChip = page.getByRole("button", { name: "All", exact: true });

    await runningChip.click();
    await expect(runningChip).toHaveAttribute("aria-pressed", "true");
    await expect(allChip).toHaveAttribute("aria-pressed", "false");
    await expect(row(page, pending.id)).toHaveCount(0);

    // Clicking the same chip again releases it — no separate escape hatch.
    await runningChip.click();
    await expect(runningChip).toHaveAttribute("aria-pressed", "false");
    // Nothing selected *is* the unfiltered state, so All lights up on its own.
    await expect(allChip).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, pending.id)).toBeVisible();
    await expect(row(page, running.id)).toBeVisible();
  });

  test("All clears an existing selection", async ({ page, request }) => {
    const prefix = uniquePrefix("clear");
    const pending = (await (
      await request.post("/api/jobs/", { data: { name: `${prefix}Pending` } })
    ).json()) as Job;

    await page.goto("/");

    await page.getByRole("button", { name: "Completed", exact: true }).click();
    await page.getByRole("button", { name: "Cancelled", exact: true }).click();
    await expect(row(page, pending.id)).toHaveCount(0);

    await page.getByRole("button", { name: "All", exact: true }).click();

    // Every chip released, not just the ones All happens to know about.
    for (const label of ["Pending", "Running", "Completed", "Failed", "Cancelled"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    await expect(row(page, pending.id)).toBeVisible();
  });

  test("shows an error banner and stays interactive when the list fails (E4)", async ({ page }) => {
    await page.route("**/api/jobs/?*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
      }),
    );

    await page.goto("/");

    await expect(page.getByRole("alert")).toBeVisible();
    // Not a blank screen: the heading and the filters are still usable.
    await expect(page.getByRole("heading", { name: "Job Management Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Running", exact: true })).toBeEnabled();
  });

  test("recovers when the failure clears (E5)", async ({ page }) => {
    // Fail every attempt until the test says otherwise. The app retries a failed
    // query once — correct, since a single blip should not surface an error —
    // so injecting one failure would be absorbed and prove nothing.
    let failing = true;
    await page.route("**/api/jobs/?*", (route) =>
      failing
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
          })
        : route.continue(),
    );

    await page.goto("/");
    await expect(page.getByRole("alert")).toBeVisible();

    failing = false;
    await page.getByRole("button", { name: "Retry" }).click();

    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".rows .row").first()).toBeVisible();
  });

  test("renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(page.locator(".rows .row").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});
