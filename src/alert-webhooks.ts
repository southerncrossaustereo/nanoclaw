import {
  registerRoute,
  bearerAuth,
  loadWebhookTokens,
} from './http-server.js';
import {
  normalizeAzureMonitor,
  normalizeJiraSM,
  normalizeGeneric,
} from './alert-normalizers.js';
import { ingestAlert } from './alert-ingestion.js';
import { getRecentAlerts } from './alert-db.js';
import { logger } from './logger.js';

export function registerAlertWebhooks(): void {
  const tokens = loadWebhookTokens();
  const auth =
    Object.keys(tokens).length > 0 ? [bearerAuth(tokens)] : [];

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
    auth,
  );

  registerRoute(
    'POST',
    '/alerts/jira',
    async (_req, res, body) => {
      try {
        const normalized = normalizeJiraSM(
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
        logger.error(
          { err: err.message },
          'Jira SM alert normalization failed',
        );
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
    auth,
  );

  registerRoute(
    'POST',
    '/alerts/generic',
    async (_req, res, body) => {
      try {
        const normalized = normalizeGeneric(
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
        logger.error(
          { err: err.message },
          'Generic alert normalization failed',
        );
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
    auth,
  );

  // Status endpoint — no auth, useful for debugging
  registerRoute('GET', '/alerts/status', async (_req, res) => {
    const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = getRecentAlerts(since1h, 100);
    const bySeverity: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const a of recent) {
      bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
      bySource[a.source] = (bySource[a.source] || 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        lastHour: {
          total: recent.length,
          bySeverity,
          bySource,
        },
      }),
    );
  });

  logger.info(
    { authEnabled: auth.length > 0 },
    'Alert webhook routes registered',
  );
}
