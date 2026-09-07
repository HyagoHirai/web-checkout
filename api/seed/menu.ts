/**
 * The menu's only source of truth (menu administration is out of scope, ADR-001).
 * Fixed lowercase UUIDs so tests can reference items; exactly one item is unavailable so the first
 * screen shows the state (US1 scenario 3).
 */
export interface SeedMenuItem {
  id: string;
  slug: string;
  name: string;
  priceMinor: number;
  available: boolean;
  sortOrder: number;
}

export const MENU: readonly SeedMenuItem[] = [
  { id: '0a1d2c3b-0001-4a5b-8c6d-000000000001', slug: 'coffee', name: 'Coffee', priceMinor: 350, available: true, sortOrder: 10 },
  { id: '0a1d2c3b-0002-4a5b-8c6d-000000000002', slug: 'latte', name: 'Latte', priceMinor: 475, available: true, sortOrder: 20 },
  { id: '0a1d2c3b-0003-4a5b-8c6d-000000000003', slug: 'iced-tea', name: 'Iced tea', priceMinor: 300, available: true, sortOrder: 30 },
  { id: '0a1d2c3b-0004-4a5b-8c6d-000000000004', slug: 'water', name: 'Sparkling water', priceMinor: 250, available: true, sortOrder: 40 },
  { id: '0a1d2c3b-0005-4a5b-8c6d-000000000005', slug: 'bagel', name: 'Bagel with cream cheese', priceMinor: 525, available: true, sortOrder: 50 },
  { id: '0a1d2c3b-0006-4a5b-8c6d-000000000006', slug: 'croissant', name: 'Butter croissant', priceMinor: 425, available: true, sortOrder: 60 },
  { id: '0a1d2c3b-0007-4a5b-8c6d-000000000007', slug: 'sandwich', name: 'Turkey sandwich', priceMinor: 895, available: true, sortOrder: 70 },
  { id: '0a1d2c3b-0008-4a5b-8c6d-000000000008', slug: 'cookie', name: 'Chocolate chip cookie', priceMinor: 275, available: true, sortOrder: 80 },
  { id: '0a1d2c3b-0009-4a5b-8c6d-000000000009', slug: 'soup', name: 'Soup of the day', priceMinor: 650, available: false, sortOrder: 90 },
];
