import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import fs from 'fs';

import { WEBHOOK_TOKENS_PATH } from './config.js';
import { logger } from './logger.js';

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => Promise<void> | void;

export type HttpMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
) => Promise<void> | void;

interface Route {
  method: string;
  path: string;
  handler: HttpHandler;
  middleware: HttpMiddleware[];
}

let server: Server | null = null;
const routes: Route[] = [];
const globalMiddleware: HttpMiddleware[] = [];

/**
 * Register a route on the shared HTTP server.
 */
export function registerRoute(
  method: string,
  path: string,
  handler: HttpHandler,
  middleware: HttpMiddleware[] = [],
): void {
  routes.push({ method: method.toUpperCase(), path, handler, middleware });
  logger.info({ method: method.toUpperCase(), path }, 'HTTP route registered');
}

/**
 * Add middleware that runs on ALL routes.
 */
export function useGlobalMiddleware(mw: HttpMiddleware): void {
  globalMiddleware.push(mw);
}

/**
 * Read and parse the request body as JSON.
 * Returns null for empty bodies or non-JSON content.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Run a middleware chain, then call the final handler.
 */
async function runMiddleware(
  middlewares: HttpMiddleware[],
  req: IncomingMessage,
  res: ServerResponse,
  finalFn: () => Promise<void>,
): Promise<void> {
  let idx = 0;
  const next = async (): Promise<void> => {
    if (idx < middlewares.length) {
      const mw = middlewares[idx++];
      await mw(req, res, next);
    } else {
      await finalFn();
    }
  };
  await next();
}

/**
 * Built-in CORS middleware.
 */
function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return Promise.resolve();
  }
  return next();
}

/**
 * Create a bearer token auth middleware.
 * Any valid token grants access. Token name is logged for auditing.
 */
export function bearerAuth(
  tokens: Record<string, string>,
): HttpMiddleware {
  const tokenIndex = new Map<string, string>();
  for (const [name, value] of Object.entries(tokens)) {
    tokenIndex.set(value, name);
  }

  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
      return;
    }

    const token = authHeader.slice(7);
    const tokenName = tokenIndex.get(token);
    if (!tokenName) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }

    (req as any)._tokenName = tokenName;
    await next();
  };
}

/**
 * Load webhook bearer tokens from ~/.config/nanoclaw/webhook-tokens.json
 * Returns empty object if file doesn't exist.
 */
export function loadWebhookTokens(): Record<string, string> {
  try {
    const raw = fs.readFileSync(WEBHOOK_TOKENS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Start the shared HTTP server.
 */
export async function startHttpServer(port: number): Promise<Server> {
  if (server) {
    logger.warn('HTTP server already running');
    return server;
  }

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const method = req.method || '';

    // CORS preflight
    if (method === 'OPTIONS') {
      corsMiddleware(req, res, async () => {
        res.writeHead(204);
        res.end();
      });
      return;
    }

    // Global health endpoint
    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        routes: routes.map(r => `${r.method} ${r.path}`),
      }));
      return;
    }

    // Find matching route
    const route = routes.find(r => r.method === method && r.path === url);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(method)
        ? await readBody(req)
        : null;

      const allMiddleware = [...globalMiddleware, ...route.middleware];
      await runMiddleware(allMiddleware, req, res, async () => {
        await route.handler(req, res, body);
      });
    } catch (err: any) {
      logger.error({ err: err?.message, method, url }, 'HTTP handler error');
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server!.listen(port, () => {
      logger.info({ port, routeCount: routes.length }, 'Shared HTTP server started');
      resolve(server!);
    });
    server!.on('error', reject);
  });
}

/**
 * Stop the shared HTTP server.
 */
export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

/**
 * Reset all module state. Test-only.
 */
export function _resetForTests(): void {
  routes.length = 0;
  globalMiddleware.length = 0;
  server = null;
}
