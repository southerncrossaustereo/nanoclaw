import { createRemoteJWKSet, jwtVerify } from 'jose';
import { registerRoute } from './http-server.js';
import type { HttpMiddleware } from './http-server.js';
import {
  normalizeAzureMonitor,
  normalizeJiraSM,
  normalizeGeneric,
} from './alert-normalizers.js';
import { ingestAlert } from './alert-ingestion.js';
import { getRecentAlerts, getPendingAlerts } from './alert-db.js';
import { logger } from './logger.js';

function entraIdAuth(): HttpMiddleware {
  const tenantId = process.env.AZURE_TENANT_ID;
  const audience = process.env.AZURE_CLIENT_ID;

  if (!tenantId || !audience) {
    logger.warn(
      'AZURE_TENANT_ID or AZURE_CLIENT_ID not set — Azure alert endpoint is unauthenticated',
    );
    return (_req, _res, next) => next();
  }

  const JWKS = createRemoteJWKSet(
    new URL(
      `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    ),
  );
  const issuer = `https://sts.windows.net/${tenantId}/`;

  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Authorization header' }));
      return;
    }
    const token = authHeader.slice(7);
    try {
      await jwtVerify(token, JWKS, { issuer, audience });
      await next();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Azure webhook JWT validation failed');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
    }
  };
}

export function registerAlertWebhooks(): void {
  const azureAuth = [entraIdAuth()];

  registerRoute(
    'POST',
    '/alerts/azure',
    async (_req, res, body) => {
      try {
        const normalized = normalizeAzureMonitor(
          body as Record<string, unknown>,
        );
        const alert = ingestAlert(normalized);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'accepted',
            alertId: alert.id,
            fingerprint: alert.fingerprint,
          }),
        );
      } catch (err: any) {
        logger.error({ err: err.message }, 'Azure alert normalization failed');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
    azureAuth,
  );

  registerRoute('POST', '/alerts/jira', async (_req, res, body) => {
    try {
      const normalized = normalizeJiraSM(body as Record<string, unknown>);
      const alert = ingestAlert(normalized);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'accepted',
          alertId: alert.id,
          fingerprint: alert.fingerprint,
        }),
      );
    } catch (err: any) {
      logger.error({ err: err.message }, 'Jira SM alert normalization failed');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  registerRoute('POST', '/alerts/generic', async (_req, res, body) => {
    try {
      const normalized = normalizeGeneric(body as Record<string, unknown>);
      const alert = ingestAlert(normalized);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'accepted',
          alertId: alert.id,
          fingerprint: alert.fingerprint,
        }),
      );
    } catch (err: any) {
      logger.error({ err: err.message }, 'Generic alert normalization failed');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // Status endpoint — no auth, useful for debugging
  registerRoute('GET', '/alerts/status', async (_req, res) => {
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = getRecentAlerts(since1h, 100);
    const bySeverity: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byInvestigationStatus: Record<string, number> = {};
    for (const a of recent) {
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
      bySource[a.source] = (bySource[a.source] || 0) + 1;
      const s = a.investigationStatus || 'unknown';
      byInvestigationStatus[s] = (byInvestigationStatus[s] || 0) + 1;
    }
    const pending = getPendingAlerts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        lastHour: {
          total: recent.length,
          bySeverity,
          bySource,
          byInvestigationStatus,
        },
        pendingInvestigations: {
          count: pending.length,
          alerts: pending.map((a) => ({
            id: a.id,
            type: a.type,
            severity: a.severity,
            status: a.status,
            investigationStatus: a.investigationStatus,
            firedAt: a.firedAt,
          })),
        },
      }),
    );
  });

  logger.info('Alert webhook routes registered');
}
