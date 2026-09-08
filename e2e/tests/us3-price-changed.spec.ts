import { expect, test } from '@playwright/test';
import { withMenuChange } from '../fixtures/db.ts';
import { choose, delta, goToPayment, metrics, pay, startAndAdd } from './kiosk.ts';

test('US3: a price change that moves the total is rejected before payment; re-confirm at the new total is accepted', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
  await expect(page.locator('[data-total]')).toHaveText('$7.00');
  await goToPayment(page);
  await withMenuChange([{ slug: 'coffee', priceMinor: 400 }], async () => {
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
    await expect(page.getByText('A price changed while you were ordering')).toBeVisible();
    await expect(page.locator('[data-screen="rejected"] [data-total]')).toHaveText('$8.00');
    const mid = await metrics(page);
    expect(delta(before, mid, 'orders.validation_rejected.price_mismatch')).toBe(1);
    expect(delta(before, mid, 'orders.accepted')).toBe(0);

    await page.locator('[data-action="review-again"]').tap();
    await expect(page.locator('[data-screen="review"]')).toBeVisible();
    await expect(page.locator('[data-screen="review"] [data-total]')).toHaveText('$8.00');
    await page.getByRole('button', { name: 'Continue to payment' }).tap();
    await expect(page.locator('[data-screen="payment"] [data-total]')).toHaveText('$8.00');
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Payment confirmed, $8.00')).toBeVisible();
  });
  const after = await metrics(page);
  expect(delta(before, after, 'orders.accepted')).toBe(1);
});

test('a re-pricing that pushes the total above $1,000.00 blocks confirmation on the client until the order is reduced (FR-006)', async ({ page }) => {
  await page.goto('/');
  // 5 sandwiches at $200.00 = exactly $1,000.00 is allowed; the fixture then raises the price
  await withMenuChange([{ slug: 'sandwich', priceMinor: 20_000 }], async () => {
    await page.getByRole('button', { name: 'Start your order' }).tap();
    await expect(page.getByRole('button', { name: 'Add Turkey sandwich' })).toBeVisible();
    for (let i = 0; i < 5; i += 1) await page.getByRole('button', { name: i === 0 ? 'Add Turkey sandwich' : 'More Turkey sandwich' }).tap();
    await expect(page.locator('[data-total]')).toHaveText('$1,000.00');
    await goToPayment(page);
    await withMenuChange([{ slug: 'sandwich', priceMinor: 20_200 }], async () => {
      await choose(page, 'success');
      await pay(page);
      await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
      await page.locator('[data-action="review-again"]').tap();
      await expect(page.locator('[data-screen="menu"]')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
      await expect(page.locator('[data-blocker="total_out_of_bounds"]')).toBeVisible();
      await page.getByRole('button', { name: 'Fewer Turkey sandwich' }).tap();
      await expect(page.getByRole('button', { name: 'Review order' })).toBeEnabled();
    });
  });
});

test('after a rejection, confirming again first checks the rejected key; a concurrent acceptance is shown, not re-paid', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
  await goToPayment(page);
  // the first POST is answered with a crafted 422 while the real request goes through and pays K1
  await page.route('**/api/orders', async (route) => {
    const res = await route.fetch(); // the server accepts and pays K1 ($7.00)
    await res.json();
    await route.fulfill({ status: 422, json: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: 'x', currentTotalMinor: 800, currentItems: [], affectedItemIds: [] } });
  }, { times: 1 });
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
  await expect(page.getByText('This attempt was not accepted')).toBeVisible();
  await page.locator('[data-action="review-again"]').tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  // the last check finds K1 paid: the recorded order is shown; no second key, no second payment
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Payment confirmed, $7.00')).toBeVisible();
  const after = await metrics(page);
  expect(delta(before, after, 'orders.accepted')).toBe(1);
  expect(delta(before, after, 'payment.executed.success')).toBe(1);
});

test('when the last check of a rejected key fails, no new payment is offered; a retry that finds the order shows it', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
  await goToPayment(page);
  await page.route('**/api/orders', async (route) => {
    const res = await route.fetch(); // the server accepts and pays K1 ($7.00)
    await res.json();
    await route.fulfill({ status: 422, json: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: 'x', currentTotalMinor: 800, currentItems: [], affectedItemIds: [] } });
  }, { times: 1 });
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
  await page.locator('[data-action="review-again"]').tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  // the last check cannot reach the service
  await page.route('**/api/orders/by-key/**', (route) => route.abort('connectionrefused'), { times: 1 });
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await expect(page.getByText('We could not check your previous attempt')).toBeVisible();
  await expect(page.locator('[data-screen="payment"]')).toHaveCount(0);
  // the service is back: the retry finds the paid order
  await page.locator('[data-action="try-again"]').tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Payment confirmed, $7.00')).toBeVisible();
  const after = await metrics(page);
  expect(delta(before, after, 'orders.accepted')).toBe(1);
  expect(delta(before, after, 'payment.executed.success')).toBe(1);
});

test('a 404 that is not the API\'s not_found body keeps the key and starts nothing', async ({ page }) => {
  const before = await metrics(page);
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
  await goToPayment(page);
  await page.route('**/api/orders', async (route) => {
    const res = await route.fetch(); // the server accepts and pays K1
    await res.json();
    await route.fulfill({ status: 422, json: { error: 'validation_rejected', reasons: ['price_mismatch'], interactionId: 'x', currentTotalMinor: 800, currentItems: [], affectedItemIds: [] } });
  }, { times: 1 });
  await choose(page, 'success');
  await pay(page);
  await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
  await page.locator('[data-action="review-again"]').tap();
  // an HTML 404 from an intermediary answers the last check
  await page.route('**/api/orders/by-key/**', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>Not Found</body></html>' }), { times: 1 });
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="error"]')).toBeVisible();
  await expect(page.locator('[data-screen="payment"]')).toHaveCount(0);
  await expect(page.getByText('previous attempt has not been checked')).toBeVisible();
  await page.locator('[data-action="try-again"]').tap();
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
  const after = await metrics(page);
  expect(delta(before, after, 'orders.accepted')).toBe(1);
});

test('a re-pricing that needs two decrements can be reduced step by step', async ({ page }) => {
  await page.goto('/');
  await withMenuChange([{ slug: 'sandwich', priceMinor: 20_000 }], async () => {
    await page.getByRole('button', { name: 'Start your order' }).tap();
    await page.getByRole('button', { name: 'Add Turkey sandwich' }).tap();
    for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: 'More Turkey sandwich' }).tap();
    await expect(page.locator('[data-total]')).toHaveText('$1,000.00');
    await goToPayment(page);
    await withMenuChange([{ slug: 'sandwich', priceMinor: 30_000 }], async () => {
      await choose(page, 'success');
      await pay(page);
      await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
      await page.locator('[data-action="review-again"]').tap();
      await expect(page.locator('[data-screen="menu"]')).toBeVisible();
      await expect(page.locator('[data-total]')).toHaveText('$1,500.00');
      await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
      await page.getByRole('button', { name: 'Fewer Turkey sandwich' }).tap();
      await expect(page.locator('[data-total]')).toHaveText('$1,200.00'); // still over, but the decrement applied
      await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
      await page.getByRole('button', { name: 'Fewer Turkey sandwich' }).tap();
      await expect(page.locator('[data-total]')).toHaveText('$900.00');
      await expect(page.getByRole('button', { name: 'Review order' })).toBeEnabled();
    });
  });
});
