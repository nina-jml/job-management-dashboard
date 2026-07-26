import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { history, uniquePrefix } from "./helpers";

/**
 * Step 6 — the create form.
 *
 * TEST_PLAN cases B1 (created job appears without a refresh), B2 and B3
 * (client-side validation fires no request), plus the failure path where the
 * typed name must survive.
 */

const nameField = (page: Page) => page.getByLabel("New job");
const submit = (page: Page) => page.getByRole("button", { name: /^Create/ });

/** Counts list POSTs, so "fired no request" can be asserted rather than assumed. */
function countCreateRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/jobs/")) count += 1;
  });
  return () => count;
}

test.describe("create job", () => {
  test("creates a job and shows it without a refresh (B1)", async ({ page }) => {
    const name = `${uniquePrefix("b1")}Transonic Wing Sweep`;

    await page.goto("/");
    await nameField(page).fill(name);
    await submit(page).click();

    // Appears in the list with no navigation — the dynamic-update requirement.
    const row = page.locator(".row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.locator(".status")).toHaveText(/Pending/);

    // And it is really on the server, not just in the client cache.
    await page.reload();
    await expect(page.locator(".row").filter({ hasText: name })).toBeVisible();
  });

  test("clears the input after a successful create (B1)", async ({ page }) => {
    await page.goto("/");
    await nameField(page).fill(`${uniquePrefix("clear")}Job`);
    await submit(page).click();

    await expect(nameField(page)).toHaveValue("");
  });

  test("the new job starts with exactly one PENDING entry (B1)", async ({ page, request }) => {
    const name = `${uniquePrefix("log")}Job`;

    await page.goto("/");
    await nameField(page).fill(name);
    await submit(page).click();
    await expect(page.locator(".row").filter({ hasText: name })).toBeVisible();

    const { results } = (await (await request.get(`/api/jobs/?page_size=100`)).json()) as {
      results: { id: number; name: string }[];
    };
    const created = results.find((job) => job.name === name)!;
    const log = await history(request, created.id);

    expect(log.results).toHaveLength(1);
    expect(log.results[0]!.status_type).toBe("PENDING");
  });

  test("rejects an empty name without calling the API (B2)", async ({ page }) => {
    await page.goto("/");
    const creates = countCreateRequests(page);

    await submit(page).click();

    await expect(page.getByText("Enter a name for the job.")).toBeVisible();
    // The point of client-side validation: the server is never asked a question
    // whose answer is already known.
    expect(creates()).toBe(0);
  });

  test("rejects a whitespace-only name without calling the API (B3)", async ({ page }) => {
    await page.goto("/");
    const creates = countCreateRequests(page);

    await nameField(page).fill("   ");
    await submit(page).click();

    await expect(page.getByText("Enter a name for the job.")).toBeVisible();
    expect(creates()).toBe(0);
  });

  test("rejects an over-long name without calling the API (B4)", async ({ page }) => {
    await page.goto("/");
    const creates = countCreateRequests(page);

    await nameField(page).fill("x".repeat(201));
    await submit(page).click();

    await expect(page.getByText(/limited to 200 characters/)).toBeVisible();
    expect(creates()).toBe(0);
  });

  test("clears the validation message once typing resumes", async ({ page }) => {
    await page.goto("/");
    await submit(page).click();
    await expect(page.getByText("Enter a name for the job.")).toBeVisible();

    await nameField(page).fill("A");

    await expect(page.getByText("Enter a name for the job.")).toHaveCount(0);
  });

  test("keeps the typed name when the server rejects the create (B5)", async ({ page }) => {
    const name = `${uniquePrefix("b5")}Doomed Job`;

    await page.route("**/api/jobs/", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ detail: "Internal server error.", errors: {} }),
          })
        : route.continue(),
    );

    await page.goto("/");
    await nameField(page).fill(name);
    await submit(page).click();

    await expect(page.getByRole("alert")).toBeVisible();
    // Losing what someone typed because the server failed is its own bug.
    await expect(nameField(page)).toHaveValue(name);
  });

  test("shows a server field error beside the input, not in the page banner", async ({ page }) => {
    await page.route("**/api/jobs/", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "name: This field may not be blank.",
              errors: { name: ["This field may not be blank."] },
            }),
          })
        : route.continue(),
    );

    await page.goto("/");
    await nameField(page).fill("Anything");
    await submit(page).click();

    await expect(page.locator(".field-error")).toHaveText("This field may not be blank.");
  });

  test("stores unicode and markup verbatim, rendered as text (B6)", async ({ page }) => {
    const name = `${uniquePrefix("b6")}Δp «flow» 🔥 <script>alert(1)</script>`;

    await page.goto("/");
    await nameField(page).fill(name);
    await submit(page).click();

    // Scoped to the run-unique name, not to "«flow»": that substring is shared
    // by every previous run's fixture, so the loose locator matches several
    // rows the moment the suite runs twice without `make clean` — the isolation
    // property case A3 is meant to guarantee.
    const row = page.locator(".row").filter({ hasText: name });
    await expect(row).toBeVisible();
    // Rendered as text: the markup is visible, not executed or stripped.
    await expect(row.locator("b").first()).toHaveText(name);
  });

  test("accepts a name the server counts as under the limit", async ({ page }) => {
    // 120 astral-plane characters: 120 to Python and Postgres, 240 to
    // String.length, which counts each surrogate pair twice. A code-unit check
    // rejects this client-side — and per B4's own contract fires no request —
    // so the user cannot create a name the API would have taken with a 201.
    const name = `${uniquePrefix("astral")}${"🔥".repeat(120)}`;
    expect([...name].length).toBeLessThan(200);
    expect(name.length).toBeGreaterThan(200);

    await page.goto("/");
    await nameField(page).fill(name);
    await submit(page).click();

    await expect(page.locator(".row").filter({ hasText: name })).toBeVisible();
  });

  test("a server field error clears once the name is edited", async ({ page }) => {
    await page.route("**/api/jobs/", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Invalid input.",
          errors: { name: ["That name is already taken."] },
        }),
      });
    });

    await page.goto("/");
    await nameField(page).fill("Rejected Name");
    await submit(page).click();

    await expect(page.getByText("That name is already taken.")).toBeVisible();

    // Nothing else can clear it: the page banner — and its Dismiss button, the
    // only caller of reset() — is deliberately not rendered for field errors.
    // So the message has to belong to the value that earned it, or it outlives
    // the input and marks a freshly typed name invalid before submission.
    await nameField(page).fill("A Different Name");
    await expect(page.getByText("That name is already taken.")).toHaveCount(0);
    await expect(nameField(page)).toHaveAttribute("aria-invalid", "false");
  });
});
