import { expect, test } from '@playwright/test';
import { choose, delta, goToPayment, metrics, pay, startAndAdd } from './kiosk.ts';

test('US6: a decline keeps the items; trying again is a new order; the first stays failed', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 1 }, { name: 'Chocolate chip cookie', times: 2 }]);
  await goToPayment(page);
  await choose(page, 'declined');
  await pay(page);
  await expect(page.locator('[data-screen="declined"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('The card terminal declined the payment')).toBeVisible();
  await expect(page.locator('[data-screen="declined"] .review-line')).toHaveCount(2);
  await page.locator('[data-action="try-again"]').tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and pay/ }).tap();
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
  const after = await metrics(page);
  expect(delta(before, after, 'payment.executed.declined')).toBe(1);
  expect(delta(before, after, 'payment.executed.success')).toBe(1);
  expect(delta(before, after, 'orders.accepted')).toBe(2);
});
