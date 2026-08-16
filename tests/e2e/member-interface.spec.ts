import { expect, test } from '@playwright/test';

for (const viewport of [
  { height: 900, name: 'desktop', width: 1440 },
  { height: 844, name: 'mobile', width: 390 },
]) {
  test(`visitor member interface is responsive on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto('/rewrite');

    await expect(page.getByRole('heading', { name: 'AI Text Rewriter' })).toBeVisible();
    await expect(page.getByLabel('Text to rewrite')).toBeEditable();
    await expect(page.getByLabel('Tone')).toBeDisabled();
    await expect(page.getByLabel('Formality')).toBeDisabled();
    await expect(page.getByLabel('Rewrite strength')).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Sign in to rewrite' })).toBeVisible();
    expect(
      await page
        .locator('html')
        .evaluate((documentElement) => documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('login provides Magic Link and Google sign-in without overflowing', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto('/login');

  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email me a Magic Link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  expect(
    await page
      .locator('html')
      .evaluate((documentElement) => documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test('account requires an authenticated session', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Watermark Lens' })).toBeVisible();
});
