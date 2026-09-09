import { expect, test } from '@playwright/test';
import { choose, expectClientEvent, goToPayment, pay, startAndAdd } from './kiosk.ts';

/** A gate the test opens, plus signals for "the server has answered" and "the client has received it". */
function heldResponse() {
  let release!: () => void;
  let fetched!: () => void;
  let delivered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const wasFetched = new Promise<void>((r) => { fetched = r; });
  const wasDelivered = new Promise<void>((r) => { delivered = r; });
  return { release, gate, fetched, wasFetched, delivered, wasDelivered };
}

test.describe('US9: late responses never leak or regress (P3, not optional)', () => {
  test('a response for a concluded interaction never appears in the next one (FR-032)', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    const h = heldResponse();
    await page.route('**/api/orders', async (route) => {
      const res = await route.fetch(); // the server executes the payment now
      h.fetched();
      await h.gate; // ...but the client only hears about it after the interaction ended
      try { await route.fulfill({ response: res }); } catch { /* ignore */ }
      h.delivered();
    }, { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    await h.wasFetched;
    await page.getByRole('button', { name: 'Start new order' }).tap();
    await page.getByRole('button', { name: 'Start your order' }).tap();
    await expect(page.locator('[data-screen="menu"]')).toBeVisible();
    const discarded = expectClientEvent(page, 'foreign_response_discarded');
    h.release();
    await h.wasDelivered;
    await discarded; // the browser reported the discard; delivery of the beacon is not this test's claim
    await expect(page.locator('[data-screen="menu"]')).toBeVisible();
    await expect(page.locator('[data-screen="confirmed"]')).toHaveCount(0);
  });

  test('a stale response never regresses a displayed final result (FR-033)', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await goToPayment(page);
    // The POST reaches the server (paid) but its response is held, then delivered as a STALE view
    // (pending) after polling has already established paid. The client's own polls are real.
    const h = heldResponse();
    await page.route('**/api/orders', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      h.fetched();
      await h.gate;
      try { await route.fulfill({ status: 202, json: { ...body, state: 'pending_payment' } }); } catch { /* ignore */ }
      h.delivered();
    }, { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await h.wasFetched;
    await page.clock.runFor(8_500); // polling starts and finds the paid order
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 10_000 });
    const referenceShown = (await page.locator('[data-reference]').textContent())!.trim();
    const discarded = expectClientEvent(page, 'stale_response_discarded');
    h.release();
    await h.wasDelivered;
    await discarded; // emitted for the current key, after the late arrival; delivery is proven in the API tests
    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible();
    await expect(page.locator('[data-reference]')).toHaveText(referenceShown);
    // and the 15 s display was not restarted by the late arrival
    await page.clock.runFor(15_500);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
  });
});
