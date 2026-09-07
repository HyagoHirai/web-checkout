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
    await page.getByRole('button', { name: /Confirm and pay/ }).tap();
    await expect(page.locator('[data-screen="payment"] [data-total]')).toHaveText('$8.00');
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Payment confirmed, $8.00')).toBeVisible();
  });
  const after = await metrics(page);
  expect(delta(before, after, 'orders.accepted')).toBe(1);
});
