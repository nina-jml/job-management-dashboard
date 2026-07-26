import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { uniquePrefix, type Job } from "./helpers";

/**
 * Slice 8 — deleting a job through the UI.
 *
 * TEST_PLAN cases D1 (row goes, and stays gone after a reload), D5 (a failed
 * delete restores the row) and D6 (an unrelated expanded timeline is
 * undisturbed), plus E9 and E10 — the two `client.ts` failure branches pulled
 * forward from slice 9, because every network call in the app goes through that
 * file and nothing exercised them.
 */

const row = (page: Page, id: number) => page.locator(`[data-job-id="${id}"]`);

/** `goto` resolves on load, not on data; clicking mid-render is a flake. */
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

async function openDeleteDialog(page: Page, id: number) {
  await row(page, id).getByRole("button", { name: /^Delete/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("delete a job", () => {
  test("confirms, then the row disappears and stays gone (D1)", async ({ page, request }) => {
    const job = await makeJob(request, "d1");

    await page.goto("/");
    await listReady(page);
    await expect(row(page, job.id)).toBeVisible();

    await openDeleteDialog(page, job.id);
    // The dialog names the job rather than asking "are you sure?" about
    // something it has not identified.
    await expect(page.getByRole("dialog")).toContainText(job.name);

    await page.getByRole("button", { name: "Delete job" }).click();

    // (a) gone with no manual refresh — the "UI updates dynamically" requirement
    await expect(row(page, job.id)).toHaveCount(0);

    // (b) gone from the server too, not just the client cache
    await page.reload();
    await listReady(page);
    await expect(row(page, job.id)).toHaveCount(0);
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(404);
  });

  test("never opens a native dialog", async ({ page, request }) => {
    const job = await makeJob(request, "native");

    // `window.confirm` blocks the browser's event loop, so Playwright stops
    // receiving commands and the suite *hangs* rather than failing. Asserting
    // the absence is worth a test: it is the difference between a red gate and
    // one that eats its timeout with no information.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.type());
      void dialog.dismiss();
    });

    await page.goto("/");
    await listReady(page);
    await openDeleteDialog(page, job.id);
    await page.getByRole("button", { name: "Delete job" }).click();
    await expect(row(page, job.id)).toHaveCount(0);

    expect(nativeDialogs).toEqual([]);
  });

  test("cancelling deletes nothing", async ({ page, request }) => {
    const job = await makeJob(request, "cancel");

    await page.goto("/");
    await listReady(page);
    await openDeleteDialog(page, job.id);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row(page, job.id)).toBeVisible();
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(200);
  });

  test("dismisses on Escape without deleting", async ({ page, request }) => {
    const job = await makeJob(request, "escape");

    await page.goto("/");
    await listReady(page);
    await openDeleteDialog(page, job.id);

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(200);
  });

  test("Escape still works after focus leaves the buttons", async ({ page, request }) => {
    const job = await makeJob(request, "escape-blur");

    await page.goto("/");
    await listReady(page);
    await openDeleteDialog(page, job.id);

    // Click the explanatory text. It is not focusable, so focus falls back to
    // <body> — and a keydown handler bound to the dialog element would never
    // see the keypress again, because the dialog div is not focusable either
    // and nothing inside it is focused to bubble from. The previous test
    // presses Escape while Cancel still holds focus, so it cannot catch this.
    await page.locator(".dialog p").click();
    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(200);
  });

  test("keeps Tab inside the dialog", async ({ page, request }) => {
    const job = await makeJob(request, "focus-trap");

    await page.goto("/");
    await listReady(page);
    await openDeleteDialog(page, job.id);

    // aria-modal="true" tells assistive tech the rest of the page is inert. It
    // does not make it so, so tabbing has to be held inside deliberately or the
    // attribute is a claim the app does not honour.
    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => document.activeElement?.closest(".dialog") !== null,
      );
      expect(inside).toBe(true);
    }
  });

  test("restores the row when the delete fails (D5)", async ({ page, request }) => {
    const job = await makeJob(request, "d5");

    await page.goto("/");
    await listReady(page);

    await page.route(`**/api/jobs/${job.id}/`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
      });
    });

    // Stall the reconciling refetch, registered after the first load so only
    // the refetch is held.
    //
    // This is what makes the test bite. `useDeleteJob` invalidates the list in
    // `finally`, so without the stall the row reappears from the server whether
    // or not the rollback ran — delete the snapshot restore and the test still
    // passes, which would make it a test of invalidation wearing rollback's
    // name.
    await page.route("**/api/jobs/?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.continue();
    });

    await openDeleteDialog(page, job.id);
    await page.getByRole("button", { name: "Delete job" }).click();

    // Back well inside the stall, so the only thing that can have restored it
    // is the rollback.
    await expect(row(page, job.id)).toBeVisible({ timeout: 2000 });
    await expect(page.getByRole("alert").filter({ hasText: /Internal server error/i })).toBeVisible();

    // And it is genuinely still there, not just re-rendered.
    expect((await request.get(`/api/jobs/${job.id}/`)).status()).toBe(200);
  });

  test("leaves another row's expanded timeline alone (D6)", async ({ page, request }) => {
    const keep = await makeJob(request, "d6-keep");
    const remove = await makeJob(request, "d6-remove");

    await page.goto("/");
    await listReady(page);

    await row(page, keep.id).getByRole("button", { name: /status history/i }).click();
    await expect(page.locator(".history")).toBeVisible();

    await openDeleteDialog(page, remove.id);
    await page.getByRole("button", { name: "Delete job" }).click();

    await expect(row(page, remove.id)).toHaveCount(0);
    // The unrelated row keeps both its place and its expanded state — deleting
    // one row must not collapse a panel the user opened on another.
    await expect(row(page, keep.id)).toBeVisible();
    await expect(page.locator(".history")).toBeVisible();
  });

  test("a job deleted elsewhere is not an error (D1 corollary)", async ({ page, request }) => {
    const job = await makeJob(request, "already-gone");

    await page.goto("/");
    await listReady(page);
    await expect(row(page, job.id)).toBeVisible();

    // Deleted from under the loaded page — another tab, or a colleague.
    expect((await request.delete(`/api/jobs/${job.id}/`)).status()).toBe(204);

    await openDeleteDialog(page, job.id);
    await page.getByRole("button", { name: "Delete job" }).click();

    // The user asked for it to be gone and it is gone. Reporting a 404 here
    // shows an error for an outcome that matches the intent, which is how
    // people learn to ignore error banners.
    await expect(row(page, job.id)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

/**
 * The two `client.ts` branches nothing else reaches. Both are driven through
 * the list request because that is the path with a visible Retry affordance.
 */
test.describe("network-level failures", () => {
  test("an unreachable server offers a retry (E9)", async ({ page }) => {
    // Not an HTTP error — the request never completes. `fetch` rejects, and
    // client.ts maps that to ApiError(status 0), which is the value
    // `isRetryable` reads to decide whether Retry is offered at all.
    await page.route("**/api/jobs/?*", (route) => route.abort());

    await page.goto("/");

    const banner = page.getByRole("alert");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Couldn't reach the server/i);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a non-JSON error body reads as an error, not a parser crash (E10)", async ({ page }) => {
    // What nginx actually returns when the backend is down: an HTML error page
    // with an HTML content type. `JSON.parse` throws on it, and that throw must
    // not reach the user as "Unexpected token '<'".
    await page.route("**/api/jobs/?*", (route) =>
      route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>",
      }),
    );

    await page.goto("/");

    const banner = page.getByRole("alert");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/server returned an error \(502\)/i);
    await expect(banner).not.toContainText(/unexpected token/i);
    await expect(banner).not.toContainText(/JSON/i);
  });
});
