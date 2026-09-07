import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.ts';
import { UUID_PATTERN } from '../../../shared/constants.ts';
import { INTERACTION_HEADER } from '../../../shared/wire.ts';

export function interactionIdOf(request: FastifyRequest): string | undefined {
  const v = request.headers[INTERACTION_HEADER];
  const s = Array.isArray(v) ? v[0] : v;
  return s && UUID_PATTERN.test(s) ? s : undefined;
}

/**
 * One JSON error shape for 400/404/409/422/500 (contract `Error`). Installing setErrorHandler
 * bypasses Fastify's default error logging, so 5xx are logged here with the stack and 4xx without
 * it (research R1, R13). Every reply carries Cache-Control: no-store and x-request-id.
 */
export function registerErrorHandling(app: App): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', requestId: request.id, interactionId: interactionIdOf(request) });
  });

  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const interactionId = interactionIdOf(request);
    if (status >= 500) {
      app.counters.inc('server.unhandled_error');
      request.log.error({ event: 'server.unhandled_error', err, interactionId }, 'unhandled error');
      reply.code(500).send({ error: 'internal', requestId: request.id, interactionId });
      return;
    }
    request.log.info({ event: 'request.rejected', status, code: err.code, message: err.message, interactionId }, 'request rejected');
    const code = status === 400 ? 'bad_request' : status === 404 ? 'not_found' : status === 415 ? 'unsupported_media_type' : 'request_error';
    reply.code(status).send({ error: code, requestId: request.id, interactionId, detail: err.message });
  });
}
