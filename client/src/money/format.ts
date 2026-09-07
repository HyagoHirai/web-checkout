/** Constructed once: construction is the expensive part. Fed minor/100, exact for 0..100000 (research R7). */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMinor(minor: number): string {
  return usd.format(minor / 100);
}
