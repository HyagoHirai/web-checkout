import { expect, test, type Page } from '@playwright/test';
import { startAndAdd } from '../tests/kiosk.ts';

/**
 * Real back/forward cache restores (pageshow.persisted === true) are asserted here, not assumed.
 * goBack waits for 'commit' because a bfcache restore fires no load event.
 */
async function armPersistedProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __persisted: boolean | null }).__persisted = null;
    window.addEventListener('pageshow', (e) => { (window as unknown as { __persisted: boolean | null }).__persisted = e.persisted; });
  });
}
async function persisted(page: Page): Promise<boolean | null> {
  return page.evaluate(() => (window as unknown as { __persisted: boolean | null }).__persisted);
}

test.describe('back/forward cache (FR-028, SC-004)', () => {
  test('a document restored from bfcache never shows the cart of an interaction another document ended', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await expect(page.locator('[data-line]')).toHaveCount(1);
    await armPersistedProbe(page);
    // a second document of the same app in the same tab; the first goes into the bfcache with A in its heap
    await page.goto('/?second');
    await expect(page.locator('[data-screen="menu"]')).toBeVisible(); // A hydrated (cart empty by design)
    await page.getByRole('button', { name: 'Start new order' }).tap();
    await page.getByRole('button', { name: 'Start your order' }).tap(); // interaction B
    await expect(page.locator('[data-screen="menu"]')).toBeVisible();
    const b = await page.evaluate(() => JSON.parse(sessionStorage.getItem('webcheckout.interaction')!).id as string);
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(500);
    expect(await persisted(page)).toBe(true); // the restore was real
    await expect(page.locator('[data-line]')).toHaveCount(0); // nothing of A
    const shown = await page.evaluate(() => JSON.parse(sessionStorage.getItem('webcheckout.interaction')!).id as string);
    expect(shown).toBe(b); // the restored document adopted the tab's current interaction and did not overwrite it
  });

  test('after a reset in another document, the restored document is idle', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await armPersistedProbe(page);
    await page.goto('/?second');
    await page.getByRole('button', { name: 'Start new order' }).tap();
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(500);
    expect(await persisted(page)).toBe(true);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await expect(page.locator('[data-line]')).toHaveCount(0);
  });

  test('a bfcache restore of a still-current interaction keeps the cart (the tab-switch guarantee holds here too)', async ({ page }) => {
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 2 }]);
    await armPersistedProbe(page);
    await page.goto('about:blank');
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(500);
    expect(await persisted(page)).toBe(true);
    await expect(page.locator('[data-line]')).toHaveCount(1);
    await expect(page.locator('[data-total]')).toHaveText('$7.00');
  });

  test('US5 on a real restore: a restored document whose deadline has passed resets by the clock, not by memory', async ({ page }) => {
    // page.clock cannot age a document while it is frozen in the bfcache (the fake clock lives inside the
    // document), so the clock is advanced after the restore; the same normalisation then runs on the ticker.
    await page.clock.install({ time: new Date('2026-09-07T12:00:00Z') });
    await page.goto('/');
    await startAndAdd(page, [{ name: 'Coffee', times: 1 }]);
    await armPersistedProbe(page);
    await page.goto('about:blank');
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForTimeout(500);
    expect(await persisted(page)).toBe(true);
    await expect(page.locator('[data-line]')).toHaveCount(1); // still valid: 0.5 s elapsed
    await page.clock.runFor(95_000);
    await expect(page.locator('[data-screen="idle"]')).toBeVisible();
    await expect(page.locator('[data-line]')).toHaveCount(0);
  });
});
