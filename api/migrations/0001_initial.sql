-- Web Checkout initial schema. Applied by api/src/db/migrate.ts inside ONE transaction:
-- no BEGIN/COMMIT here, no CREATE INDEX CONCURRENTLY.
-- Design: specs/001-web-checkout/data-model.md

CREATE TABLE menu_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL,
    name        text NOT NULL,
    price_minor integer NOT NULL,
    currency    text NOT NULL DEFAULT 'USD',
    available   boolean NOT NULL DEFAULT true,
    sort_order  integer NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT menu_items_slug_key UNIQUE (slug),
    CONSTRAINT menu_items_price_minor_positive CHECK (price_minor > 0),
    CONSTRAINT menu_items_currency_usd CHECK (currency = 'USD')
);

CREATE TABLE orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key     uuid NOT NULL,
    fingerprint         text NOT NULL,
    interaction_id      uuid NOT NULL,
    reference           text NOT NULL,
    state               text NOT NULL,
    currency            text NOT NULL,
    total_minor         integer NOT NULL,
    snapshot            jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    outcome_recorded_at timestamptz NULL,
    -- The arbiter for INSERT ... ON CONFLICT (idempotency_key) and the concurrency backstop (ADR-002).
    CONSTRAINT orders_idempotency_key_key UNIQUE (idempotency_key),
    -- Named so a 23505 on the reference can be told apart from the key (research R5, R7).
    CONSTRAINT orders_reference_key UNIQUE (reference),
    CONSTRAINT orders_reference_alphabet CHECK (reference ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'),
    CONSTRAINT orders_state_valid CHECK (state IN ('pending_payment', 'paid', 'failed')),
    CONSTRAINT orders_currency_usd CHECK (currency = 'USD'),
    CONSTRAINT orders_total_minor_bounds CHECK (total_minor > 0 AND total_minor <= 100000)
);

CREATE INDEX orders_created_at_idx ON orders (created_at);
