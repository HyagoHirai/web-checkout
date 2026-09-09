import { expect, test } from '@playwright/test';
import { expectClientEvent } from './kiosk.ts';

test('US8: an unreachable service before submission shows plain language and a way back', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/menu', (route) => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Start your order' }).tap();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await expect(page.getByText('We could not reach the ordering service')).toBeVisible();
  // a reload during the outage still renders the app (nginx serves it) and shows the error again
  await page.reload();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await page.unroute('**/api/menu');
  const reported = expectClientEvent(page, 'service_unreachable');
  await page.locator('[data-action="try-again"]').tap();
  await expect(page.locator('[data-screen="menu"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Coffee' })).toBeVisible();
  await reported; // emitted on the recovery action; whether it lands is best-effort by design
});
