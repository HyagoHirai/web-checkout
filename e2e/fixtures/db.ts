import pg from 'pg';

const port = process.env.DB_PORT ?? '54329';
const url = process.env.DATABASE_URL ?? `postgres://checkout:checkout@127.0.0.1:${port}/webcheckout`;

/** Menu fixtures via the database, never through an admin path (ADR-001). Always restore in teardown. */
export async function withMenuChange<T>(changes: { slug: string; priceMinor?: number; available?: boolean }[], fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const originals: { slug: string; price_minor: number; available: boolean }[] = [];
  try {
    for (const c of changes) {
      const r = await client.query<{ price_minor: number; available: boolean }>('SELECT price_minor, available FROM menu_items WHERE slug = $1', [c.slug]);
      originals.push({ slug: c.slug, ...r.rows[0] });
      if (c.priceMinor !== undefined) await client.query('UPDATE menu_items SET price_minor = $2 WHERE slug = $1', [c.slug, c.priceMinor]);
      if (c.available !== undefined) await client.query('UPDATE menu_items SET available = $2 WHERE slug = $1', [c.slug, c.available]);
    }
    return await fn();
  } finally {
    for (const o of originals) await client.query('UPDATE menu_items SET price_minor = $2, available = $3 WHERE slug = $1', [o.slug, o.price_minor, o.available]);
    await client.end();
  }
}

export async function orderByKey(key: string): Promise<{ state: string; reference: string } | null> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ state: string; reference: string }>('SELECT state, reference FROM orders WHERE idempotency_key = $1', [key]);
    return r.rows[0] ?? null;
  } finally {
    await client.end();
  }
}
