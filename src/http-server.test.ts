import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./config.js', () => ({
  WEBHOOK_TOKENS_PATH: '/tmp/nanoclaw-test-webhook-tokens.json',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startHttpServer,
  stopHttpServer,
  registerRoute,
  useGlobalMiddleware,
  bearerAuth,
  loadWebhookTokens,
  _resetForTests,
} from './http-server.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

describe('http-server', () => {
  let httpServer: http.Server;

  afterEach(async () => {
    await stopHttpServer();
    _resetForTests();
  });

  describe('server lifecycle', () => {
    it('starts and listens on the given port', async () => {
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);
      expect(port).toBeGreaterThan(0);

      const res = await makeRequest(port, { method: 'GET', path: '/health' });
      expect(res.statusCode).toBe(200);
    });

    it('returns existing server if already running', async () => {
      httpServer = await startHttpServer(0);
      const second = await startHttpServer(0);
      expect(second).toBe(httpServer);
    });

    it('stopHttpServer shuts down cleanly', async () => {
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);
      await stopHttpServer();

      await expect(
        makeRequest(port, { method: 'GET', path: '/health' }),
      ).rejects.toThrow();
    });
  });

  describe('health endpoint', () => {
    it('returns status ok with registered routes', async () => {
      registerRoute('GET', '/test', async (_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, { method: 'GET', path: '/health' });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.routes).toContain('GET /test');
    });
  });

  describe('route dispatch', () => {
    it('dispatches to registered GET route', async () => {
      registerRoute('GET', '/ping', async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, { method: 'GET', path: '/ping' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('pong');
    });

    it('dispatches to registered POST route with parsed JSON body', async () => {
      let receivedBody: unknown = null;
      registerRoute('POST', '/echo', async (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/echo',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ hello: 'world' }),
      );
      expect(res.statusCode).toBe(200);
      expect(receivedBody).toEqual({ hello: 'world' });
    });

    it('returns 404 for unregistered routes', async () => {
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('Not found');
    });

    it('returns 404 when method does not match', async () => {
      registerRoute('POST', '/only-post', async (_req, res) => {
        res.writeHead(200);
        res.end();
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/only-post',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when handler throws', async () => {
      registerRoute('GET', '/error', async () => {
        throw new Error('boom');
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, { method: 'GET', path: '/error' });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Internal server error');
    });
  });

  describe('CORS', () => {
    it('responds to OPTIONS preflight with correct headers', async () => {
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, {
        method: 'OPTIONS',
        path: '/any-path',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain(
        'Authorization',
      );
    });
  });

  describe('bearerAuth middleware', () => {
    const tokens = {
      'azure-monitor': 'secret-token-azure',
      'jira-webhook': 'secret-token-jira',
    };

    it('rejects requests with no Authorization header', async () => {
      registerRoute(
        'POST',
        '/webhook',
        async (_req, res) => {
          res.writeHead(200);
          res.end('ok');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toContain('Authorization');
    });

    it('rejects requests with invalid bearer token', async () => {
      registerRoute(
        'POST',
        '/webhook',
        async (_req, res) => {
          res.writeHead(200);
          res.end('ok');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer wrong-token',
          },
        },
        '{}',
      );
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('Invalid token');
    });

    it('rejects non-Bearer authorization schemes', async () => {
      registerRoute(
        'POST',
        '/webhook',
        async (_req, res) => {
          res.writeHead(200);
          res.end('ok');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            'content-type': 'application/json',
            authorization: 'Basic dXNlcjpwYXNz',
          },
        },
        '{}',
      );
      expect(res.statusCode).toBe(401);
    });

    it('allows requests with valid bearer token', async () => {
      registerRoute(
        'POST',
        '/webhook',
        async (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('accepted');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-token-azure',
          },
        },
        '{"alert": "cpu high"}',
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('accepted');
    });

    it('attaches token name to request for auditing', async () => {
      let capturedTokenName: string | undefined;
      registerRoute(
        'POST',
        '/webhook',
        async (req, res) => {
          capturedTokenName = (req as any)._tokenName;
          res.writeHead(200);
          res.end('ok');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhook',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-token-jira',
          },
        },
        '{}',
      );
      expect(capturedTokenName).toBe('jira-webhook');
    });

    it('accepts any valid token from the set', async () => {
      registerRoute(
        'POST',
        '/webhook',
        async (_req, res) => {
          res.writeHead(200);
          res.end('ok');
        },
        [bearerAuth(tokens)],
      );
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      // Both tokens should work
      for (const token of ['secret-token-azure', 'secret-token-jira']) {
        const res = await makeRequest(
          port,
          {
            method: 'POST',
            path: '/webhook',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
          },
          '{}',
        );
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('per-route vs global middleware isolation', () => {
    it('bearerAuth only applies to routes that use it', async () => {
      const tokens = { admin: 'secret-admin-token' };

      // Protected route
      registerRoute(
        'POST',
        '/protected',
        async (_req, res) => {
          res.writeHead(200);
          res.end('secret data');
        },
        [bearerAuth(tokens)],
      );

      // Unprotected route (like Teams /api/messages)
      registerRoute('POST', '/api/messages', async (_req, res) => {
        res.writeHead(200);
        res.end('message received');
      });

      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      // /api/messages works without any auth
      const unprotectedRes = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/messages',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
      expect(unprotectedRes.statusCode).toBe(200);
      expect(unprotectedRes.body).toBe('message received');

      // /protected rejects without auth
      const noAuthRes = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/protected',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
      expect(noAuthRes.statusCode).toBe(401);

      // /protected accepts with valid auth
      const authRes = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/protected',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer secret-admin-token',
          },
        },
        '{}',
      );
      expect(authRes.statusCode).toBe(200);
      expect(authRes.body).toBe('secret data');
    });
  });

  describe('global middleware', () => {
    it('runs global middleware on all routes', async () => {
      const calls: string[] = [];
      useGlobalMiddleware(async (_req, _res, next) => {
        calls.push('global');
        await next();
      });

      registerRoute('GET', '/a', async (_req, res) => {
        calls.push('handler-a');
        res.writeHead(200);
        res.end();
      });
      registerRoute('GET', '/b', async (_req, res) => {
        calls.push('handler-b');
        res.writeHead(200);
        res.end();
      });

      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      await makeRequest(port, { method: 'GET', path: '/a' });
      await makeRequest(port, { method: 'GET', path: '/b' });

      expect(calls).toEqual(['global', 'handler-a', 'global', 'handler-b']);
    });

    it('global middleware can short-circuit (reject request)', async () => {
      useGlobalMiddleware(async (_req, res, _next) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service unavailable' }));
        // Not calling next() — request is rejected
      });

      registerRoute('GET', '/test', async (_req, res) => {
        res.writeHead(200);
        res.end('should not reach');
      });

      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      const res = await makeRequest(port, { method: 'GET', path: '/test' });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('should not reach');
    });
  });

  describe('Teams /api/messages auth model', () => {
    it('Teams route relies on Bot Framework adapter auth, not bearerAuth', async () => {
      // Simulate what Teams channel does: register /api/messages with NO middleware
      let adapterReceivedAuth: string | undefined;
      registerRoute('POST', '/api/messages', async (req, res) => {
        // In the real code, adapter.process() validates the JWT internally.
        // The route handler receives the raw request with its Authorization header
        // and passes it to the adapter, which handles auth validation.
        adapterReceivedAuth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'processed' }));
      });

      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      // Request with Azure Bot Framework JWT (arbitrary value — validation is
      // the adapter's job, not the HTTP server's)
      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/messages',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer azure-bot-jwt-token',
          },
        },
        JSON.stringify({ type: 'message', text: 'hello' }),
      );
      expect(res.statusCode).toBe(200);
      // The Authorization header is passed through to the handler (and thus to
      // the Bot Framework adapter) — it is NOT intercepted by bearerAuth
      expect(adapterReceivedAuth).toBe('Bearer azure-bot-jwt-token');
    });

    it('Teams route is accessible without NanoClaw webhook tokens', async () => {
      // Even with bearerAuth on OTHER routes, /api/messages has no middleware
      const webhookTokens = { 'alert-source': 'secret-alert-token' };

      // Protected webhook route
      registerRoute(
        'POST',
        '/webhooks/alerts',
        async (_req, res) => {
          res.writeHead(200);
          res.end('alert ok');
        },
        [bearerAuth(webhookTokens)],
      );

      // Teams route — no NanoClaw auth middleware
      registerRoute('POST', '/api/messages', async (_req, res) => {
        res.writeHead(200);
        res.end('teams ok');
      });

      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      // Teams route works with its own auth header (Azure JWT, not a NanoClaw token)
      const teamsRes = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/messages',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer some-azure-jwt',
          },
        },
        '{}',
      );
      expect(teamsRes.statusCode).toBe(200);
      expect(teamsRes.body).toBe('teams ok');

      // Alert webhook rejects with Azure JWT (not a valid NanoClaw token)
      const alertRes = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/webhooks/alerts',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer some-azure-jwt',
          },
        },
        '{}',
      );
      expect(alertRes.statusCode).toBe(403);
    });
  });

  describe('loadWebhookTokens', () => {
    it('returns empty object when file does not exist', () => {
      const tokens = loadWebhookTokens();
      expect(tokens).toEqual({});
    });

    it('loads tokens from file', async () => {
      const fs = await import('fs');
      const testTokens = { 'test-source': 'test-token-value' };
      fs.writeFileSync(
        '/tmp/nanoclaw-test-webhook-tokens.json',
        JSON.stringify(testTokens),
      );

      const tokens = loadWebhookTokens();
      expect(tokens).toEqual(testTokens);

      // Cleanup
      fs.unlinkSync('/tmp/nanoclaw-test-webhook-tokens.json');
    });
  });

  describe('body parsing', () => {
    it('passes null body for GET requests', async () => {
      let receivedBody: unknown = 'not-set';
      registerRoute('GET', '/check', async (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200);
        res.end();
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      await makeRequest(port, { method: 'GET', path: '/check' });
      expect(receivedBody).toBeNull();
    });

    it('returns raw string for non-JSON POST body', async () => {
      let receivedBody: unknown = null;
      registerRoute('POST', '/raw', async (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200);
        res.end();
      });
      httpServer = await startHttpServer(0);
      const port = getPort(httpServer);

      await makeRequest(
        port,
        {
          method: 'POST',
          path: '/raw',
          headers: { 'content-type': 'text/plain' },
        },
        'not json at all',
      );
      expect(receivedBody).toBe('not json at all');
    });
  });
});
