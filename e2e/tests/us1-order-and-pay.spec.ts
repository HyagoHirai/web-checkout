import { expect, test } from '@playwright/test';
import { choose, delta, goToPayment, metrics, pay, REFERENCE, startAndAdd } from './kiosk.ts';

test.describe('US1: order and pay at the kiosk', () => {
  test('idle → menu → cart → review → simulated payment → confirmation → idle after 15 s', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    const before = await metrics(page);
    await page.goto('/');
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();

    await startAndAdd(page, [{ name: 'Coffee', times: 2 }, { name: 'Latte', times: 1 }]);
    await expect(page.locator('[data-total]')).toHaveText('$11.75');

    // NFR-002: every screen states what to do next
    await expect(page.getByText('Review your order to pay.')).toBeVisible();

    // qty 0 removes (FR-004)
    await page.getByRole('button', { name: 'Fewer Latte' }).tap();
    await expect(page.locator('[data-line]')).toHaveCount(1);
    await expect(page.locator('[data-total]')).toHaveText('$7.00');

    // an unavailable item cannot be added (FR-003)
    await expect(page.getByRole('button', { name: 'Add Soup of the day' })).toBeDisabled();

    // an eleventh of one item is refused (FR-006)
    for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'More Coffee' }).tap();
    await expect(page.getByLabel('Quantity of Coffee')).toHaveText('10');
    await expect(page.getByRole('button', { name: 'More Coffee' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add Coffee' })).toBeDisabled();
    for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'Fewer Coffee' }).tap();
    await expect(page.locator('[data-total]')).toHaveText('$7.00');

    await goToPayment(page);
    await expect(page.locator('[data-screen="payment"] [data-total]')).toHaveText('$7.00');
    await expect(page.getByText('This kiosk does not take real cards')).toBeVisible();
    await expect(page.locator('[data-simulation="success"]')).toHaveAttribute('aria-pressed', 'true');

    // NFR-003: the waiting state appears immediately on tap, before the server answers
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/orders', async (route) => { await gate; await route.continue(); }, { times: 1 });
    await choose(page, 'success');
    await pay(page);
    await expect(page.locator('[data-screen="waiting"]')).toBeVisible();
    release();

    await expect(page.locator('[data-screen="confirmed"]')).toBeVisible({ timeout: 15_000 });
    const reference = (await page.locator('[data-reference]').textContent())?.trim() ?? '';
    expect(reference).toMatch(REFERENCE);

    // FR-013: 15 s later, idle without any action
    await page.clock.runFor(15_500);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();

    const after = await metrics(page);
    expect(delta(before, after, 'payment.executed.success')).toBe(1);
    expect(delta(before, after, 'orders.accepted')).toBe(1);
  });

  test('submitting with an empty cart is not possible (FR-005)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start your order' }).tap();
    await expect(page.getByRole('button', { name: 'Review order' })).toBeDisabled();
  });
});
