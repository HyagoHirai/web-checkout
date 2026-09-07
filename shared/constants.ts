/**
 * Values that both the API and the client enforce. Imported by relative path from both packages
 * (Node's type stripping will not load .ts from node_modules, so this is not a workspace package).
 * Every number here is an owner decision recorded in specs/001-web-checkout/spec.md (OV-1..OV-6)
 * or in ADR-005.
 */

export const CURRENCY = 'USD' as const;

/** FR-006 / OV-5 */
export const MAX_QTY_PER_LINE = 10;
export const MAX_UNITS_PER_ORDER = 50;
export const MAX_TOTAL_MINOR = 100_000; // $1,000.00

/** FR-012 / OV-6: 31 symbols, no 0, O, 1, I, L. */
export const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERENCE_LENGTH = 4;
export const REFERENCE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** OV-1..OV-3 and ADR-005. Milliseconds. */
export const NETWORK_WAIT_MS = 8_000;
export const POLL_INTERVAL_MS = 2_000;
export const POLL_MAX_MS = 30_000;
export const CONFIRMATION_MS = 15_000;
export const INACTIVITY_MS = 90_000;
export const WARNING_MS = 15_000;

/** Lowercase hyphenated UUID, any version. Byte-identical across client, wire and database. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UUID_PATTERN_SOURCE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
