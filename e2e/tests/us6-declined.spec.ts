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
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
  const after = await metrics(page);
  expect(delta(before, after, 'payment.executed.declined')).toBe(1);
  expect(delta(before, after, 'payment.executed.success')).toBe(1);
  expect(delta(before, after, 'orders.accepted')).toBe(2);
});

test('Edit order after a decline, then re-confirm, is a new intent with the edited items; the first stays failed', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
  await goToPayment(page);
  await choose(page, 'declined');
  await pay(page);
  await expect(page.locator('[data-screen="declined"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Edit order' }).tap();
  await expect(page.locator('[data-screen="menu"]')).toBeVisible();
  await page.getByRole('button', { name: 'Add Latte' }).tap();
  await expect(page.locator('[data-total]')).toHaveText('$8.25');
  await goToPayment(page);
  await expect(page.locator('[data-screen="payment"] [data-total]')).toHaveText('$8.25');
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Payment confirmed, $8.25')).toBeVisible();
  const after = await metrics(page);
  expect(delta(before, after, 'payment.executed.declined')).toBe(1);
  expect(delta(before, after, 'payment.executed.success')).toBe(1);
  expect(delta(before, after, 'orders.accepted')).toBe(2);
});

test('a menu refresh that finishes on the payment screen with an item unavailable returns to the cart, flagged, and sends nothing', async ({ page }) => {
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 1 }, { name: 'Latte', times: 1 }]);
  await goToPayment(page);
  await choose(page, 'declined');
  await pay(page);
  await expect(page.locator('[data-screen="declined"]')).toBeVisible({ timeout: 15_000 });
  // hold the refresh that Try again starts, then answer it with Coffee unavailable
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/menu', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { currency: string; items: { name: string; available: boolean }[] };
    await gate;
    try { await route.fulfill({ json: { ...body, items: body.items.map((i) => (i.name === 'Coffee' ? { ...i, available: false } : i)) } }); } catch { /* ignore */ }
  }, { times: 1 });
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/orders')) posts.push(r.url()); });
  await page.locator('[data-action="try-again"]').tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="payment"]')).toBeVisible();
  release();
  await expect(page.locator('[data-screen="menu"]')).toBeVisible();
  await expect(page.locator('.line.flagged')).toHaveCount(1);
  await expect(page.locator('[data-line]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
  expect(posts).toHaveLength(0);
});
