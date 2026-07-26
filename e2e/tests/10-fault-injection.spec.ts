import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { uniquePrefix, type Job } from "./helpers";

/**
 * Step 10 — the fault-injection pass.
 *
 * Test code only. Not to be confused with the production *sweeper* the README
 * describes, which is a scheduled reconciler and was deliberately not built.
 *
 * This step deliberately does **not** re-test "500 on each verb": that already
 * exists where each verb lives — GET list in `05`, POST in `06`, PATCH in `07`,
 * DELETE in `08` — and repeating it here would be theatre rather than coverage.
 * What is here is the ground none of those touch:
 *
 *   1. the history endpoint failing at all
 *   2. recovery after a failed *mutation* (E5 only ever covered the list)
 *   3. a dropped connection mid-mutation (E9 only covered the list)
 *   4. slow responses as a visible state rather than an apparent freeze
 *
 * Error handling is built into each step's definition of done; this pass
 * proves it holds, it is not where it gets written.
 */

const row = (page: Page, id: number) => page.locator(`[data-job-id="${id}"]`);

const SERVER_ERROR = {
  status: 500,
  contentType: "application/json",
  body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
};

async function listReady(page: Page) {
  await expect(page.locator(".rows, .empty").first()).toBeVisible();
}

async function makeJob(request: Page["request"], label: string): Promise<Job> {
  const response = await request.post("/api/jobs/", {
    data: { name: `${uniquePrefix(label)}job` },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Job>;
}

/**
 * Break the first matching request only, then let everything through.
 *
 * One-shot rather than permanent because the interesting assertion is
 * *recovery*: an app that reports a failure but can never move past it has
 * handled the error only in the sense that it did not crash.
 */
async function failOnce(
  page: Page,
  pattern: string,
  method: string,
  handle: (route: Route) => Promise<void>,
) {
  let spent = false;
  await page.route(pattern, async (route) => {
    if (spent || route.request().method() !== method) return route.continue();
    spent = true;
    await handle(route);
  });
}

async function setStatus(page: Page, id: number, label: string) {
  await row(page, id).getByRole("button", { name: /Edit status/ }).click();
  await row(page, id).locator("select").selectOption({ label });
}

test.describe("the history endpoint failing", () => {
  test("a 500 on the timeline is reported, and the row stays usable", async ({ page, request }) => {
    const job = await makeJob(request, "hist-500");

    await page.route(`**/api/jobs/${job.id}/statuses/*`, (route) => route.fulfill(SERVER_ERROR));

    await page.goto("/");
    await listReady(page);
    await row(page, job.id).getByRole("button", { name: /status history/i }).click();

    await expect(page.locator(".history")).toContainText(/Couldn't load this job's history/i);
    // The failure is contained to the panel: the row it belongs to still works.
    await expect(row(page, job.id).getByRole("button", { name: /Edit status/ })).toBeEnabled();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);
  });

  test("an aborted timeline request fails the same way", async ({ page, request }) => {
    const job = await makeJob(request, "hist-abort");

    // A dropped connection, not an HTTP error — a different branch of client.ts
    // reaching the same panel.
    await page.route(`**/api/jobs/${job.id}/statuses/*`, (route) => route.abort());

    await page.goto("/");
    await listReady(page);
    await row(page, job.id).getByRole("button", { name: /status history/i }).click();

    await expect(page.locator(".history")).toContainText(/Couldn't load this job's history/i);
  });
});

test.describe("recovery after a failed mutation", () => {
  test("a status change succeeds on the second attempt", async ({ page, request }) => {
    const job = await makeJob(request, "recover-patch");

    await page.goto("/");
    await listReady(page);
    await failOnce(page, `**/api/jobs/${job.id}/`, "PATCH", (route) => route.fulfill(SERVER_ERROR));

    await setStatus(page, job.id, "Running");
    await expect(page.getByRole("alert")).toBeVisible();
    // Rolled back — the badge must not claim a state the server refused.
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);

    // Settled, not merely rolled back — same reasoning as the delete case: the
    // row is replaced when the reconciling refetch lands, so acting before then
    // races it.
    await expect(row(page, job.id).getByRole("button", { name: /Edit status/ })).toBeEnabled();

    // The fault is spent. The same action now has to work, and the error has to
    // go: a banner that outlives the failure it describes is its own bug.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await setStatus(page, job.id, "Running");

    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.reload();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);
  });

  test("a create succeeds on the second attempt, keeping the typed name", async ({ page }) => {
    const name = `${uniquePrefix("recover-post")}Transonic Wing Sweep`;

    await page.goto("/");
    await listReady(page);
    await failOnce(page, "**/api/jobs/", "POST", (route) => route.fulfill(SERVER_ERROR));

    await page.getByLabel("New job").fill(name);
    await page.getByRole("button", { name: /^Create/ }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    // The typed name survives, or the user retypes it to retry.
    await expect(page.getByLabel("New job")).toHaveValue(name);

    await page.getByRole("button", { name: /^Create/ }).click();

    await expect(page.locator(".row").filter({ hasText: name })).toBeVisible();
    await expect(page.getByLabel("New job")).toHaveValue("");
  });

  test("a delete succeeds on the second attempt", async ({ page, request }) => {
    const job = await makeJob(request, "recover-delete");

    await page.goto("/");
    await listReady(page);
    await failOnce(page, `**/api/jobs/${job.id}/`, "DELETE", (route) => route.fulfill(SERVER_ERROR));

    await row(page, job.id).getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("button", { name: "Yes, delete it" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(row(page, job.id)).toBeVisible();

    // Wait for the row to *settle*, not merely to reappear. The rollback puts it
    // back before `useDeleteJob`'s awaited invalidation has refetched, and the
    // row is replaced when that lands — so starting the second attempt on the
    // strength of "visible" alone races the refetch and can act on a node about
    // to be detached. An enabled Delete button is the observable signal that
    // `deletingIds` has cleared and reconciliation is done.
    //
    // Matched on the prefix rather than `/^Delete$/`: the accessible name comes
    // from `aria-label="Delete <job name>"`, so an exact match never resolves —
    // which is how the first version of this assertion managed to fail against a
    // perfectly healthy button.
    await expect(row(page, job.id).getByRole("button", { name: /^Delete/ })).toBeEnabled();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await row(page, job.id).getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("button", { name: "Yes, delete it" }).click();

    await expect(row(page, job.id)).toHaveCount(0);
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(404);
  });
});

test.describe("a dropped connection mid-mutation", () => {
  test("an aborted status change rolls back and says the server was unreachable", async ({
    page,
    request,
  }) => {
    const job = await makeJob(request, "abort-patch");

    await page.goto("/");
    await listReady(page);
    await failOnce(page, `**/api/jobs/${job.id}/`, "PATCH", (route) => route.abort());

    await setStatus(page, job.id, "Running");

    // status 0, not an HTTP status — the fetch rejection branch of client.ts,
    // reached through a mutation rather than the list for the first time.
    await expect(page.getByRole("alert")).toContainText(/Couldn't reach the server/i);
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);
  });

  test("an aborted create keeps what was typed", async ({ page }) => {
    const name = `${uniquePrefix("abort-post")}Thermal Sweep`;

    await page.goto("/");
    await listReady(page);
    await failOnce(page, "**/api/jobs/", "POST", (route) => route.abort());

    await page.getByLabel("New job").fill(name);
    await page.getByRole("button", { name: /^Create/ }).click();

    await expect(page.getByRole("alert")).toContainText(/Couldn't reach the server/i);
    await expect(page.getByLabel("New job")).toHaveValue(name);
  });
});

test.describe("slow responses are a state, not a freeze", () => {
  test("a slow create disables the form and says it is working", async ({ page }) => {
    const name = `${uniquePrefix("slow-post")}Combustion Study`;

    await page.goto("/");
    await listReady(page);
    await page.route("**/api/jobs/", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.getByLabel("New job").fill(name);
    await page.getByRole("button", { name: /^Create/ }).click();

    // Without this the button looks idle and invites a second click, which is
    // how one job becomes two.
    await expect(page.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await expect(page.getByLabel("New job")).toBeDisabled();

    await expect(page.locator(".row").filter({ hasText: name })).toBeVisible();
  });

  test("a slow delete removes the row without waiting for the server", async ({ page, request }) => {
    const job = await makeJob(request, "slow-delete");

    await page.goto("/");
    await listReady(page);
    await page.route(`**/api/jobs/${job.id}/`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await row(page, job.id).getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("button", { name: "Yes, delete it" }).click();

    // The row is removed optimistically, so the dialog closes immediately and
    // the *row* carries the in-flight state — there is nothing left to confirm.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row(page, job.id)).toHaveCount(0);
  });

  test("a slow list shows skeletons and leaves the toolbar usable", async ({ page }) => {
    await page.route("**/api/jobs/?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });

    await page.goto("/");

    await expect(page.locator(".rows[aria-busy='true']")).toBeVisible();
    // Loading the list must not lock the page: the filter and the create form
    // belong to the user, not to the request in flight.
    await expect(page.getByRole("button", { name: "Running", exact: true })).toBeEnabled();
    await expect(page.getByLabel("New job")).toBeEnabled();
  });
});
