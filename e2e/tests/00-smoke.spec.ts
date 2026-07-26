import { expect, test } from "@playwright/test";

/**
 * Step 0 — the walking skeleton.
 *
 * Proves the pipeline before any feature exists: images build, compose wires
 * the services together, nginx serves the app and proxies /api to Django, and
 * Playwright can drive all of it. TEST_PLAN cases A1, A2.
 */
test.describe("smoke", () => {
  test("health endpoint reports the API and database are up", async ({ request }) => {
    const response = await request.get("/api/health/");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  });

  test("health is reachable through the nginx proxy, not just directly", async ({ page }) => {
    // Same origin as the app: if this passes, the proxy config is right and the
    // frontend will never need CORS.
    const response = await page.request.get("/api/health/");
    expect(response.status()).toBe(200);
  });

  test("the app shell renders without console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Job Management Dashboard" })).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("unknown client-side routes fall back to the app, not a 404", async ({ page }) => {
    const response = await page.goto("/some/deep/route");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Job Management Dashboard" })).toBeVisible();
  });
});
