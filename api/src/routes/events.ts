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
      additionalProperties: { type: ['string', 'integer', 'boolean'] },
    },
  },
} as const;

/**
 * Best-effort client telemetry (constitution VI). Beacons arrive as text/plain with a JSON string
 * body; this plugin scope overrides the text/plain parser with the JSON parser. 204 on success;
 * 400 (counted) on a malformed body. The client never reads the reply.
 */
export async function eventsRoutes(app: App): Promise<void> {
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 4096 }, app.getDefaultJsonParser('ignore', 'ignore'));

  // A body that fails to parse never reaches the handler; it is still a rejected client event.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err.statusCode === 400) {
      app.counters.inc('client_event.rejected');
      request.log.info({ event: 'client.event_rejected', message: err.message }, 'client event rejected');
      reply.code(400).send({ error: 'bad_request', requestId: request.id });
      return;
    }
    reply.send(err);
  });

  app.post<{ Body: ClientEvent }>(
    '/api/events',
    {
      schema: { body: schema },
      attachValidation: true,
    },
    async (request, reply) => {
      if (request.validationError) {
        app.counters.inc('client_event.rejected');
        request.log.info({ event: 'client.event_rejected', message: request.validationError.message }, 'client event rejected');
        reply.code(400);
        return { error: 'bad_request', requestId: request.id };
      }
      const ev = request.body;
      app.counters.inc(`client_event.${ev.name}`);
      request.log.info(
        { event: 'client.event_received', name: ev.name, interactionId: ev.interactionId, idempotencyKey: ev.idempotencyKey, clientAt: ev.at, detail: ev.detail },
        'client event',
      );
      reply.code(204);
      return null;
    },
  );
}
