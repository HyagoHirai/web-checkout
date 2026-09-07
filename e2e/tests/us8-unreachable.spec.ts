import { expect, test } from '@playwright/test';
import { delta, metrics } from './kiosk.ts';

test('US8: an unreachable service before submission shows plain language and a way back', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await page.route('**/api/menu', (route) => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Start your order' }).tap();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await expect(page.getByText('We could not reach the ordering service')).toBeVisible();
  // a reload during the outage still renders the app (nginx serves it) and shows the error again
  await page.reload();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await page.unroute('**/api/menu');
  await page.locator('[data-action="try-again"]').tap();
  await expect(page.locator('[data-screen="menu"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Coffee' })).toBeVisible();
  const after = await metrics(page);
  expect(delta(before, after, 'client_event.service_unreachable')).toBe(1);
});
