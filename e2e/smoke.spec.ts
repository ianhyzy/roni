import { expect, test } from "@playwright/test";

test("home page loads with primary calls to action", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Roni — Adaptive AI coaching for Tonal owners");

  await expect(
    page.getByRole("heading", {
      name: "Your Tonal knows what you lifted. Roni knows what to do next.",
    }),
  ).toBeVisible();
  const weeklyPlanLink = page.getByRole("link", { name: "See a week in Roni" });
  await expect(weeklyPlanLink).toBeVisible();

  await weeklyPlanLink.click();

  await expect(page).toHaveURL(/\/#week$/);
  await expect(page.locator("#week")).toBeInViewport();
});

test("login page loads with the authentication form", async ({ page }) => {
  const response = await page.goto("/login");
  expect(response?.status()).toBe(200);

  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
});

test("public legal and FAQ pages remain reachable", async ({ page }) => {
  const routes = [
    { heading: "Privacy Policy", path: "/privacy" },
    { heading: "Frequently Asked Questions", path: "/faq" },
    { heading: "Terms of Service", path: "/terms" },
  ];

  for (const route of routes) {
    const response = await page.goto(route.path);
    expect(response?.status(), route.path).toBe(200);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
  }
});
