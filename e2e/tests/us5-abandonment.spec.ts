import { expect, test } from '@playwright/test';
import { orderByKey } from '../fixtures/db.ts';
import { choose, delta, goToPayment, metrics, pay, persisted, startAndAdd } from './kiosk.ts';

test.describe('US5: shared device, nothing survives a reset or expiry', () => {
  test('warning at 75 s with Continue; reset at 90 s; nothing restored after reload or back/forward', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    const before = await metrics(page);
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 3 }]);
    await page.clock.runFor(76_000);
    await expect(page.locator('[data-screen="inactivity-warning"]')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).tap();
    await expect(page.locator('[data-screen="inactivity-warning"]')).toHaveCount(0);
    await expect(page.locator('[data-line]')).toHaveCount(1); // cart kept
    await page.clock.runFor(76_000);
    await expect(page.locator('[data-screen="inactivity-warning"]')).toBeVisible();
    await page.clock.runFor(15_000);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    expect(await persisted(page)).toBeNull();

    // reload and browser navigation show nothing from before (both restore paths)
    await page.reload();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await page.goto('about:blank');
    await page.goBack();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await expect(page.locator('[data-line]')).toHaveCount(0);

    const after = await metrics(page);
    expect(delta(before, after, 'orders.accepted')).toBe(0); // abandoned cart: no order
    expect(delta(before, after, 'client_event.interaction_expired')).toBe(1);
  });

  test('a stale record is not restored after browser navigation mid-cart', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await page.goto('about:blank');
    await page.clock.runFor(95_000);
    await page.goBack();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await expect(page.locator('[data-line]')).toHaveCount(0);
  });

  test('an order abandoned after submission continues server-side', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await choose(page, 'inconclusive');
    await pay(page);
    await page.waitForTimeout(2_500);
    const key = (await persisted(page))!.submission!.idempotencyKey;
    await page.getByRole('button', { name: 'Start new order' }).tap();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    const row = await orderByKey(key);
    expect(row?.state).toBe('pending_payment');
  });
});
