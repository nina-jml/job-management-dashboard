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

    await setStatus(page, job.id, "Running");
    await expect(row(page, job.id).locator(".status")).toHaveText(/Running/);

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
});
