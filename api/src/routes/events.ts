import type { FastifyError } from 'fastify';
import type { App } from '../app.ts';
import { UUID_PATTERN_SOURCE } from '../../../shared/constants.ts';
import { CLIENT_EVENT_NAMES, type ClientEvent } from '../../../shared/wire.ts';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['interactionId', 'name', 'at'],
  properties: {
    interactionId: { type: 'string', pattern: UUID_PATTERN_SOURCE },
    idempotencyKey: { type: 'string', pattern: UUID_PATTERN_SOURCE },
    name: { type: 'string', enum: [...CLIENT_EVENT_NAMES] },
    at: { type: 'integer', minimum: 0 },
    detail: {
      type: 'object',
      maxProperties: 8,
      additionalProperties: { type: ['string', 'integer', 'boolean'], maxLength: 256 },
    },
  },
} as const;

/** An event is small by construction; this bounds every content type, and every string inside `detail`. */
const BODY_LIMIT_BYTES = 4096;

/**
 * Best-effort client telemetry (constitution VI). Beacons arrive as text/plain with a JSON string
 * body; this plugin scope overrides the text/plain parser with the JSON parser. 204 on success;
 * 400 (counted) on a malformed body, 413 (counted) on an oversized one. The client never reads the
 * reply. The endpoint is unauthenticated, so what it logs is bounded: the body limit applies to
 * every parser through the route options, not only to text/plain.
 */
export async function eventsRoutes(app: App): Promise<void> {
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, app.getDefaultJsonParser('ignore', 'ignore'));

  // A body that fails to parse or exceeds the limit never reaches the handler; it is still a rejected client event.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err.statusCode === 400 || err.statusCode === 413) {
      app.counters.inc('client_event.rejected');
      request.log.info({ event: 'client.event_rejected', status: err.statusCode, message: err.message }, 'client event rejected');
      reply.code(err.statusCode).send({ error: err.statusCode === 413 ? 'request_error' : 'bad_request', requestId: request.id });
      return;
    }
    reply.send(err);
  });

  app.post<{ Body: ClientEvent }>(
    '/api/events',
    {
      schema: { body: schema },
      attachValidation: true,
      bodyLimit: BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      if (request.validationError) {
        app.counters.inc('client_event.rejected');
        request.log.info({ event: 'client.event_rejected', message: request.validationError.message }, 'client event rejected');
        reply.code(400);
        return { error: 'bad_request', requestId: request.id };
      }
      const clientEvent = request.body;
      app.counters.inc(`client_event.${clientEvent.name}`);
      request.log.info(
        { event: 'client.event_received', name: clientEvent.name, interactionId: clientEvent.interactionId, idempotencyKey: clientEvent.idempotencyKey, clientAt: clientEvent.at, detail: clientEvent.detail },
        'client event',
      );
      reply.code(204);
      return null;
    },
  );
}
