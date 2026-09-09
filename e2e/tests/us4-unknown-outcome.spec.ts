import { expect, test } from '@playwright/test';
import { choose, delta, expectClientEvent, goToPayment, metrics, pay, persisted, startAndAdd } from './kiosk.ts';

/**
 * Timers are driven with page.clock (installed before navigation). Network is real; faults are
 * produced with page.route. `runFor` fires every due callback, which the polling loop needs.
 */
test.describe('US4: outcome unknown, honest about what is known', () => {
  test('inconclusive: S7a with the reference, no way to pay again, inactivity resumes and idle follows', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    const before = await metrics(page);
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await choose(page, 'inconclusive');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    // let the real 202 arrive (server latency 1.5 s), then drive the 30 s polling window
    await page.clock.runFor(2_500);
    await expect.poll(async () => (await persisted(page))?.submission?.knownState).toBe('pending');
    const shown = expectClientEvent(page, 'unresolved_shown');
    await page.clock.runFor(31_000);
    await expect(page.locator('[data-screen="unresolved-known"]')).toBeVisible();
    await shown;
    await expect(page.getByText('Do not pay again')).toBeVisible();
    await expect(page.locator('[data-reference]')).toHaveText(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    await expect(page.locator('[data-action="pay"]')).toHaveCount(0);
    // inactivity resumes: warning, then idle
    await page.clock.runFor(76_000);
    await expect(page.locator('[data-screen="inactivity-warning"]')).toBeVisible();
    await page.clock.runFor(16_000);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    const after = await metrics(page);
    expect(delta(before, after, 'payment.executed.inconclusive')).toBe(1);
  });

  test('the POST never reaches the server: S7b, no reference, no promise the counter will find anything', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    const before = await metrics(page);
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await page.route('**/api/orders', (route) => route.abort('connectionrefused'), { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    await page.clock.runFor(32_000); // polling started at the rejection and runs 30 s
    await expect(page.locator('[data-screen="unresolved-unknown"]')).toBeVisible();
    await expect(page.getByText('We could not confirm whether your order went through')).toBeVisible();
    await expect(page.locator('[data-reference]')).toHaveCount(0);
    const after = await metrics(page);
    expect(delta(before, after, 'orders.accepted')).toBe(0);
    expect(delta(before, after, 'status_lookup.not_found')).toBeGreaterThan(0);
  });

  test('server processed it, response lost: polling finds the paid order (FR-016 + recovery by key)', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await page.route('**/api/orders', async (route) => { await route.fetch(); await route.abort('connectionreset'); }, { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await page.clock.runFor(4_000);
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
  });

  test('a generic 500 after the order may exist is unknown, never a decline', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    await page.route('**/api/orders', async (route) => { await route.fetch(); await route.fulfill({ status: 500, json: { error: 'internal' } }); }, { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    await expect(page.locator('[data-screen="declined"]')).toHaveCount(0);
    await page.clock.runFor(10_000);
    // polling by key finds the paid order
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
  });

  test('FR-034: a definitive result arriving after the unresolved screen updates it', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    // hold the real response until the test releases it; block the polls so nothing else resolves it
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/orders', async (route) => {
      const res = await route.fetch();
      await gate;
      try { await route.fulfill({ response: res }); } catch { /* page may have moved on */ }
    }, { times: 1 });
    await page.route('**/api/orders/by-key/**', (route) => route.fulfill({ status: 404, json: { error: 'not_found' } }));
    await choose(page, 'declined');
    await pay(page);
    await page.clock.runFor(40_000);
    await expect(page.locator('[data-screen="unresolved-unknown"]')).toBeVisible();
    release();
    await expect(page.locator('[data-screen="declined"]')).toBeVisible({ timeout: 10_000 });
    // deadline preserved: the interaction is still alive well past the naive 90 s
    await page.clock.runFor(60_000);
    await expect(page.locator('[data-screen="declined"]')).toBeVisible();
  });
});
