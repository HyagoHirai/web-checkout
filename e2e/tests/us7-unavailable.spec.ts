import { expect, test } from '@playwright/test';
import { withMenuChange } from '../fixtures/db.ts';
import { choose, goToPayment, pay, startAndAdd } from './kiosk.ts';

test('US7: an item unavailable at validation is flagged, the rest preserved, payment blocked until fixed', async ({ page }) => {
  await page.goto('/');
  await startAndAdd(page, [{ name: 'Coffee', times: 1 }, { name: 'Latte', times: 1 }]);
  await goToPayment(page);
  await withMenuChange([{ slug: 'coffee', available: false }], async () => {
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="rejected"]')).toBeVisible();
    await expect(page.getByText('no longer available')).toBeVisible();
    await page.locator('[data-action="review-again"]').tap();
    await expect(page.locator('[data-screen="menu"]')).toBeVisible();
    await expect(page.locator('.line.flagged')).toHaveCount(1);
    await expect(page.locator('[data-line]')).toHaveCount(2); // the rest is preserved
    await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
    await page.getByRole('button', { name: 'Remove Coffee' }).tap();
    await expect(page.locator('[data-line]')).toHaveCount(1);
    await expect(page.locator('[data-total]')).toHaveText('$4.75');
    await goToPayment(page);
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Payment confirmed, $4.75')).toBeVisible();
  });
});
