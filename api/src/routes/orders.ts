import type { App } from '../app.ts';
import { MAX_QTY_PER_LINE, MAX_TOTAL_MINOR, MAX_UNITS_PER_ORDER, UUID_PATTERN_SOURCE } from '../../../shared/constants.ts';
import type { OrderSubmission } from '../../../shared/wire.ts';
import { interactionIdOf } from '../plugins/errors.ts';

const uuid = { type: 'string', pattern: UUID_PATTERN_SOURCE } as const;

const submissionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['idempotencyKey', 'currency', 'expectedTotalMinor', 'lines'],
  properties: {
    idempotencyKey: uuid,
    currency: { type: 'string', enum: ['USD'] },
    expectedTotalMinor: { type: 'integer', minimum: 1, maximum: MAX_TOTAL_MINOR },
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_UNITS_PER_ORDER,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'quantity'],
        properties: {
          itemId: uuid,
          quantity: { type: 'integer', minimum: 1, maximum: MAX_QTY_PER_LINE },
        },
      },
    },
    simulation: {
      type: 'object',
      additionalProperties: false,
      required: ['outcome'],
      properties: { outcome: { type: 'string', enum: ['success', 'declined', 'inconclusive'] } },
    },
  },
} as const;

const headersSchema = {
  type: 'object',
  required: ['x-interaction-id'],
  properties: { 'x-interaction-id': uuid },
} as const;

export async function ordersRoutes(app: App): Promise<void> {
  app.post<{ Body: OrderSubmission }>(
    '/api/orders',
    { schema: { body: submissionSchema, headers: headersSchema } },
    async (request, reply) => {
      const interactionId = interactionIdOf(request) as string;
      const result = await app.orders.submit({ body: request.body, interactionId, log: request.log });
      switch (result.kind) {
        case 'status':
          reply.code(result.status);
          return result.body;
        case 'rejected':
          reply.code(422);
          return result.body;
        case 'mismatch':
          reply.code(409);
          return { error: 'intent_mismatch', interactionId, requestId: request.id };
        case 'reference_exhausted':
          reply.code(503);
          return { error: 'reference_exhausted', interactionId, requestId: request.id };
      }
    },
  );

  app.get<{ Params: { idempotencyKey: string } }>(
    '/api/orders/by-key/:idempotencyKey',
    {
      schema: {
        params: { type: 'object', required: ['idempotencyKey'], properties: { idempotencyKey: uuid } },
        headers: headersSchema,
      },
    },
    async (request, reply) => {
      const interactionId = interactionIdOf(request) as string;
      const status = await app.orders.lookupByKey(request.params.idempotencyKey, interactionId, request.log);
      if (!status) {
        reply.code(404);
        return { error: 'not_found', interactionId, requestId: request.id };
      }
      return status;
    },
  );
}
