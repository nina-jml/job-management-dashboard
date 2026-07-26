import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { history, uniquePrefix, type Job } from "./helpers";

/**
 * Slice 7 — updating a job's status through the UI.
 *
 * ⭐ This is the flow the assignment names explicitly: create a job, see it as
 * PENDING, change its status, and verify the change. TEST_PLAN cases C1, C2,
 * C9 (optimistic rollback) and C12 (controls offered per state).
 */

const row = (page: Page, id: number) => page.locator(`[data-job-id="${id}"]`);

async function makeJob(request: Page["request"], label: string): Promise<Job> {
  const response = await request.post("/api/jobs/", {
    data: { name: `${uniquePrefix(label)}job` },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Job>;
}

/** Open the in-place editor and choose a status. */
async function setStatus(page: Page, id: number, label: string) {
  await row(page, id).getByRole("button", { name: /Edit/ }).click();
  await row(page, id).locator("select").selectOption({ label });
}

test.describe("update job status", () => {
  test("⭐ create → PENDING → RUNNING, and it persists (C1)", async ({ page }) => {
    const name = `${uniquePrefix("critical")}Fluid Dynamics Simulation`;

    await page.goto("/");

    // 1. create it through the UI
    await page.getByLabel("New job").fill(name);
    await page.getByRole("button", { name: /^Create/ }).click();

    const created = page.locator(".row").filter({ hasText: name });
    await expect(created).toBeVisible();

    // 2. it starts PENDING
    await expect(created.locator(".status")).toHaveText(/Pending/);

    // 3. change it to RUNNING
    await created.getByRole("button", { name: /Edit/ }).click();
    await created.locator("select").selectOption({ label: "Running" });

    // 4. the badge reflects the change
    await expect(created.locator(".status")).toHaveText(/Running/);

    // 5. and it survives a reload — persisted, not just local state
    await page.reload();
    await expect(
      page.locator(".row").filter({ hasText: name }).locator(".status"),
    ).toHaveText(/Running/);
  });

  test("walks the full lifecycle, every state reachable (C2)", async ({ page, request }) => {
    const job = await makeJob(request, "c2ui");
    await page.goto("/");

    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);

    await setStatus(page, job.id, "Failed");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Failed/);

    // A failed job offers Re-run rather than a status editor.
    await row(page, job.id).getByRole("button", { name: /Re-run/ }).click();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);

    await setStatus(page, job.id, "Running");
    await setStatus(page, job.id, "Completed");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Completed/);
  });

  test("cancels a running job (C15)", async ({ page, request }) => {
    const job = await makeJob(request, "cancel");
    await page.goto("/");

    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);

    await setStatus(page, job.id, "Cancelled");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Cancelled/);
    // Cancelled is terminal but retryable, exactly like failed.
    await expect(row(page, job.id).getByRole("button", { name: /Re-run/ })).toBeVisible();
  });

  test("offers only legal transitions, from the server (C12)", async ({ page, request }) => {
    const job = await makeJob(request, "c12ui");
    await page.goto("/");

    // From PENDING: Running, Failed and Cancelled are selectable; Completed is not.
    await row(page, job.id).getByRole("button", { name: /Edit/ }).click();
    const options = row(page, job.id).locator("select option");
    const enabled = await options.evaluateAll((nodes) =>
      nodes.filter((n) => !(n as HTMLOptionElement).disabled).map((n) => n.textContent),
    );
    expect(new Set(enabled)).toEqual(new Set(["Pending", "Running", "Failed", "Cancelled"]));
  });

  test("a completed job offers no status control at all (C12)", async ({ page, request }) => {
    const job = await makeJob(request, "terminal");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "RUNNING" } });
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "COMPLETED" } });

    await page.goto("/");

    await expect(row(page, job.id).getByText("No further changes")).toBeVisible();
    await expect(row(page, job.id).getByRole("button", { name: /Edit/ })).toHaveCount(0);
    await expect(row(page, job.id).getByRole("button", { name: /Re-run/ })).toHaveCount(0);
  });

  test("the status change lands in the job's history", async ({ page, request }) => {
    const job = await makeJob(request, "hist");
    await page.goto("/");

    // The badge moves optimistically, so it is not evidence the server has the
    // change yet. Waiting on the PATCH response is — otherwise this asserts on
    // server state that may still be in flight, which is precisely the kind of
    // pass-warm/fail-cold race the T3 tier exists to catch.
    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes(`/api/jobs/${job.id}/`),
    );
    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);
    await patched;

    const { results } = await history(request, job.id);
    // Append-only: the PENDING entry is still there.
    expect(results.map((entry) => entry.status_type)).toEqual(["RUNNING", "PENDING"]);
  });

  test("rolls the badge back when the server refuses (C9)", async ({ page, request }) => {
    const job = await makeJob(request, "rollback");

    await page.route("**/api/jobs/*/", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
          })
        : route.continue(),
    );

    await page.goto("/");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);

    await setStatus(page, job.id, "Running");

    // The optimistic badge must not survive a rejection.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);
  });

  test("an illegal transition rejected by the server also rolls back", async ({ page, request }) => {
    // The UI disables these, so force one past the control to prove the server
    // is the authority and the client copes with being told no.
    const job = await makeJob(request, "illegal");
    await page.goto("/");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);

    const response = await request.patch(`/api/jobs/${job.id}/`, {
      data: { status: "COMPLETED" },
    });
    expect(response.status()).toBe(400);

    await page.reload();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);
  });

  test("leaves the status untouched when the editor is dismissed", async ({ page, request }) => {
    const job = await makeJob(request, "dismiss");
    await page.goto("/");

    await row(page, job.id).getByRole("button", { name: /Edit/ }).click();
    await expect(row(page, job.id).locator("select")).toBeVisible();

    // Not labelled "Cancel" — that word now means stopping the job.
    await row(page, job.id).getByRole("button", { name: "Stop editing status" }).click();

    await expect(row(page, job.id).locator("select")).toHaveCount(0);
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/);
  });

  test("re-run flips the badge without waiting for the server", async ({ page, request }) => {
    const job = await makeJob(request, "rerun-fast");
    await request.patch(`/api/jobs/${job.id}/`, { data: { status: "FAILED" } });

    await page.goto("/");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Failed/);

    // Hold the PATCH open, so the badge moving can only be the optimistic
    // write and never the server's answer.
    await page.route(`**/api/jobs/${job.id}/`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    await row(page, job.id).getByRole("button", { name: /Re-run/ }).click();

    // Optimistic means immediate. A budget rather than the default 10s, because
    // "eventually correct" is exactly what an optimistic update is not for.
    await expect(row(page, job.id).locator(".status")).toHaveText(/Pending/, { timeout: 200 });
  });

  test("re-run stays immediate while a list refetch is in flight", async ({ page, request }) => {
    const failed = await makeJob(request, "rerun-contended");
    const other = await makeJob(request, "rerun-neighbour");
    await request.patch(`/api/jobs/${failed.id}/`, { data: { status: "FAILED" } });

    await page.goto("/");
    await expect(row(page, failed.id).locator(".status")).toHaveText(/Failed/);

    // Registered after the first load, so only the *refetch* is held.
    await page.route("**/api/jobs/?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.route(`**/api/jobs/${failed.id}/`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    // Changing a neighbour invalidates the list, so a refetch is now in flight
    // and stalled. This is the ordinary case, not a contrived one: every
    // settled mutation starts one, and clicking two rows in a row is normal.
    await setStatus(page, other.id, "Running");
    await row(page, failed.id).getByRole("button", { name: /Re-run/ }).click();

    // The optimistic write must not be queued behind an unrelated request.
    await expect(row(page, failed.id).locator(".status")).toHaveText(/Pending/, { timeout: 200 });
  });

  test("updates without a console error", async ({ page, request }) => {
    const job = await makeJob(request, "console");
    const errors: string[] = [];
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);

    expect(errors).toEqual([]);
  });

  test("still updates after a history panel has been opened", async ({ page, request }) => {
    const job = await makeJob(request, "hist-first");

    await page.goto("/");

    // Expanding caches the history query, whose value is a plain page with no
    // `pages` array. An optimistic writer scoped to the whole "jobs" key tree
    // reaches that entry and throws — and a throwing onMutate means the
    // mutation function never runs, so the PATCH is never sent at all while the
    // badge still flashes the new status. The suite stayed green because no
    // spec opened a history panel before changing a status.
    await row(page, job.id).getByRole("button", { name: /status history/i }).click();
    await expect(page.locator(".history")).toBeVisible();

    const patched: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patched.push(req.url());
    });

    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);

    expect(patched.some((url) => url.includes(`/api/jobs/${job.id}/`))).toBe(true);
    // Persisted, not merely optimistic.
    await page.reload();
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);
  });

  test("the row stays busy until the server's answer lands", async ({ page, request }) => {
    const job = await makeJob(request, "settling");

    await page.goto("/");
    await expect(row(page, job.id)).toBeVisible();

    await page.route(`**/api/jobs/${job.id}/`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });

    await setStatus(page, job.id, "Cancelled");

    // CANCELLED is terminal, but `allowed_transitions` and `can_retry` still
    // describe PENDING until the refetch lands — they are the server's answer
    // and are deliberately not guessed. A row that looked settled in that gap
    // would offer moves the server is about to reject, contradicting C12's
    // claim that illegal transitions are unreachable rather than just refused.
    await expect(row(page, job.id).getByRole("button", { name: /Edit status/ })).toBeDisabled();

    // Once reconciled, the row offers what CANCELLED actually permits: a
    // re-run — it is terminal *and* retryable — and no status editor at all.
    await expect(row(page, job.id).getByRole("button", { name: /Re-run/ })).toBeVisible();
    await expect(row(page, job.id).getByRole("button", { name: /Edit status/ })).toHaveCount(0);
  });

  test("a second change does not swallow the first's error", async ({ page, request }) => {
    const first = await makeJob(request, "row-first");
    const second = await makeJob(request, "row-second");

    await page.goto("/");
    await expect(row(page, first.id)).toBeVisible();
    await expect(row(page, second.id)).toBeVisible();

    // The first fails, slowly; the second succeeds meanwhile.
    await page.route(`**/api/jobs/${first.id}/`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
      });
    });

    await setStatus(page, first.id, "Running");
    await setStatus(page, second.id, "Running");

    await expect(row(page, second.id).locator(".status")).toHaveText(/Running/);

    // One shared mutation observer reports a single aggregate state, so
    // starting the second change took the first's error with it: its badge
    // rolled back and nothing said why.
    await expect(
      page.getByRole("alert").filter({ hasText: /Internal server error/i }),
    ).toBeVisible();
    await expect(row(page, first.id).locator(".status")).toHaveText(/Pending/);
  });

  test("acting on a job deleted elsewhere does not resurrect it", async ({ page, request }) => {
    const job = await makeJob(request, "deleted-elsewhere");

    await page.goto("/");
    await expect(row(page, job.id)).toBeVisible();

    // Gone from under the loaded page: another tab, or `make test` reseeding.
    // `staleTime` means the browser has no idea yet, so this is a wide window
    // rather than a narrow race.
    expect((await request.delete(`/api/jobs/${job.id}/`)).status()).toBe(204);

    await setStatus(page, job.id, "Running");

    // Rolling back to the snapshot would put a row the server says is gone back
    // on screen — a recovery as wrong as the failure. It disappears instead.
    await expect(row(page, job.id)).toHaveCount(0);
    // And the message says what happened, not the ORM's "No Job matches the
    // given query."
    await expect(page.getByRole("alert").filter({ hasText: /no longer exists/i })).toBeVisible();
  });
});
