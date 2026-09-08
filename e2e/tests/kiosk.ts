import { expect, type Page, type Request } from '@playwright/test';

export const REFERENCE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export async function metrics(page: Page): Promise<Record<string, number>> {
  const r = await page.request.get('/api/metrics');
  return ((await r.json()) as { counters: Record<string, number> }).counters;
}

export function delta(before: Record<string, number>, after: Record<string, number>, key: string): number {
  return (after[key] ?? 0) - (before[key] ?? 0);
}

/** Start an interaction and add items by name via touch. */
export async function startAndAdd(page: Page, items: { name: string; times: number }[]): Promise<void> {
  await page.getByRole('button', { name: 'Start your order' }).tap();
  await expect(page.locator('[data-screen="menu"]')).toBeVisible();
  for (const it of items) {
    for (let i = 0; i < it.times; i += 1) await page.getByRole('button', { name: `Add ${it.name}` }).tap();
  }
}

export async function goToPayment(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Review order' }).tap();
  await expect(page.locator('[data-screen="review"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue to payment' }).tap();
  await expect(page.locator('[data-screen="payment"]')).toBeVisible();
}

export async function choose(page: Page, outcome: 'success' | 'declined' | 'inconclusive'): Promise<void> {
  await page.locator(`[data-simulation="${outcome}"]`).tap();
}

export async function pay(page: Page): Promise<void> {
  await page.locator('[data-screen="payment"] [data-action="pay"]').tap();
}

/** Raw touch at the control's centre, twice, without actionability waits (research R14). */
export async function doubleTapPay(page: Page): Promise<void> {
  const box = await page.locator('[data-screen="payment"] [data-action="pay"]').boundingBox();
  if (!box) throw new Error('no pay button');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
}

export function countPosts(page: Page): { count: () => number; keys: () => string[] } {
  const seen: string[] = [];
  page.on('request', (req: Request) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/orders')) {
      const body = req.postDataJSON() as { idempotencyKey: string } | null;
      seen.push(body?.idempotencyKey ?? '?');
    }
  });
  return { count: () => seen.length, keys: () => seen };
}

/** Read the persisted interaction record (for asserting keys and phases). */
export async function persisted(page: Page): Promise<{ id: string; phase: string; submission: { idempotencyKey: string; reference: string | null; knownState: string } | null } | null> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('webcheckout.interaction');
    return raw ? JSON.parse(raw) : null;
  });
}
