import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api/client.ts';

function res(status: number, body: string, type = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

describe('lookupByKey: only the API\'s own not_found body is "not found"; anything else is an unrecognised answer', () => {
  it.each([
    ['API not_found JSON', res(404, JSON.stringify({ error: 'not_found', requestId: 'r' })), true],
    ['HTML 404 from a proxy', res(404, '<html><body>Not Found</body></html>', 'text/html'), false],
    ['invalid JSON 404', res(404, '{not json', 'application/json'), false],
    ['JSON 404 with another error code', res(404, JSON.stringify({ error: 'route_missing' })), false],
  ] as const)('%s', async (_name, response, expectNotFound) => {
    const api = createApi((async () => response) as typeof fetch);
    const r = await api.lookupByKey('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(r.category).toBe('unknown');
    expect(r.category === 'unknown' && r.notFound === true).toBe(expectNotFound);
  });
});
