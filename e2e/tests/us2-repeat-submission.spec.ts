import { expect, test } from '@playwright/test';
import { choose, countPosts, delta, doubleTapPay, goToPayment, metrics, pay, persisted, startAndAdd } from './kiosk.ts';

test.describe('US2: submitting more than once creates one order', () => {
  test('a double tap on Pay creates one order and one payment', async ({ page }) => {
    const before = await metrics(page);
    await page.goto('/');
    const posts = countPosts(page);
    await startAndAdd(page, [{ name: 'Bagel with cream cheese', times: 1 }]);
    await goToPayment(page);
    await choose(page, 'success');
    await doubleTapPay(page);
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
    expect(posts.count()).toBe(1);
    const after = await metrics(page);
    expect(delta(before, after, 'payment.executed.success')).toBe(1);
    expect(delta(before, after, 'orders.accepted')).toBe(1);
  });

  test('a refresh during submission does not create a second order; the same key is polled', async ({ page }) => {
    const before = await metrics(page);
    await page.goto('/');
    const posts = countPosts(page);
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await choose(page, 'inconclusive');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    const rec = await persisted(page);
    expect(rec?.phase).toBe('submitted');
    const key = rec!.submission!.idempotencyKey;
    await page.waitForTimeout(2_500); // let the 202 arrive
    await page.reload();
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    const afterReload = await persisted(page);
    expect(afterReload?.submission?.idempotencyKey).toBe(key);
    expect(posts.keys().filter((k) => k === key)).toHaveLength(1);
    // the wait ends ~30 s after the early pending; S7a with the same reference
    await expect(page.locator('[data-screen="unresolved-known"]')).toBeVisible({ timeout: 45_000 });
    const after = await metrics(page);
    expect(delta(before, after, 'payment.executed.inconclusive')).toBe(1);
    expect(delta(before, after, 'orders.accepted')).toBe(1);
  });

  test('Start new order during an unknown outcome creates no second payment', async ({ page }) => {
    const before = await metrics(page);
    await page.goto('/');
    const posts = countPosts(page);
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await choose(page, 'inconclusive');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    await page.waitForTimeout(2_500);
    await page.getByRole('button', { name: 'Start new order' }).tap();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    expect(await persisted(page)).toBeNull();
    expect(posts.count()).toBe(1);
    const after = await metrics(page);
    expect(delta(before, after, 'orders.accepted')).toBe(1);
    expect(delta(before, after, 'payment.executed.inconclusive')).toBe(1);
  });

  test('two genuinely separate orders with the same items are both accepted', async ({ page }) => {
    const refs: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      await page.goto('/');
      await startAndAdd(page, [{ name: 'Iced tea', times: 1 }]);
      await goToPayment(page);
      await choose(page, 'success');
      await pay(page);
      await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
      refs.push((await page.locator('[data-reference]').textContent())!.trim());
      await page.getByRole('button', { name: 'Done' }).tap();
    }
    expect(new Set(refs).size).toBe(2);
  });
});

test.describe('reload and suspension in the browser', () => {
  test('a reload before Pay loses the cart and the unsent intent; the customer starts again (spec edge case)', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await page.reload();
    await expect(page.locator('[data-screen="menu"]')).toBeVisible();
    await expect(page.locator('[data-line]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
  });

  test('a decline after a reload can be retried with the same items (finding 5)', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
    await goToPayment(page);
    // hold the POST so the reload happens mid-wait; the server records the decline meanwhile
    await page.route('**/api/orders', async (route) => { await route.fetch(); await new Promise(() => {}); }, { times: 1 });
    await choose(page, 'declined');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    await page.waitForTimeout(2_500);
    await page.reload();
    await expect(page.locator('[data-screen="declined"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-screen="declined"] .review-line')).toHaveCount(1);
    await page.locator('[data-action="try-again"]').tap();
    await expect(page.locator('[data-screen="payment"]')).toBeVisible();
    await expect(page.locator('[data-screen="payment"] [data-total]')).toHaveText('$7.00');
  });

  test('switching tabs keeps the cart (finding 2)', async ({ page, context }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.bringToFront();
    await expect(page.locator('[data-line]')).toHaveCount(1);
    await expect(page.locator('[data-total]')).toHaveText('$7.00');
    await other.close();
  });
});
