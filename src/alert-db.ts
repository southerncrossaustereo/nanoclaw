import fs from 'fs';
import path from 'path';

import { getDb } from './db.js';
import { logger } from './logger.js';
import {
  NormalizedAlert,
  AlertContext,
  AlertSubscription,
  AlertPattern,
  AlertFrequency,
  AlertKnowledge,
} from './alert-types.js';

// --- Alert CRUD ---

export function insertAlert(alert: NormalizedAlert): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO alerts (
      id, fingerprint, external_id, source, source_url,
      type, category, severity, assessed_priority, status,
      resource, resource_type, host, host_type, location, environment,
      fired_at, received_at, resolved_at,
      summary, description, metric_value, threshold,
      tags, metadata, context_id, suppressed_until,
      investigation_status, investigation_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    alert.id,
    alert.fingerprint,
    alert.externalId || null,
    alert.source,
    alert.sourceUrl || null,
    alert.type,
    alert.category,
    alert.severity,
    alert.assessedPriority || null,
    alert.status,
    alert.resource,
    alert.resourceType || null,
    alert.host || null,
    alert.hostType || null,
    alert.location || null,
    alert.environment || null,
    alert.firedAt,
    alert.receivedAt,
    alert.resolvedAt || null,
    alert.summary,
    alert.description || null,
    alert.metricValue || null,
    alert.threshold || null,
    JSON.stringify(alert.tags),
    JSON.stringify(alert.metadata),
    alert.contextId || null,
    alert.suppressedUntil || null,
    alert.investigationStatus || 'pending',
    alert.investigationSummary || null,
  );
}

function rowToAlert(row: Record<string, unknown>): NormalizedAlert {
  return {
    id: row.id as string,
    fingerprint: row.fingerprint as string,
    externalId: (row.external_id as string) || '',
    source: row.source as string,
    sourceUrl: (row.source_url as string) || undefined,
    type: row.type as string,
    category: row.category as string,
    severity: row.severity as number,
    assessedPriority: (row.assessed_priority as number) || undefined,
    status: row.status as string,
    resource: row.resource as string,
    resourceType: (row.resource_type as string) || undefined,
    host: (row.host as string) || undefined,
    hostType: (row.host_type as string) || undefined,
    location: (row.location as string) || undefined,
    environment: (row.environment as string) || undefined,
    firedAt: row.fired_at as string,
    receivedAt: row.received_at as string,
    resolvedAt: (row.resolved_at as string) || undefined,
    summary: row.summary as string,
    description: (row.description as string) || undefined,
    metricValue: (row.metric_value as string) || undefined,
    threshold: (row.threshold as string) || undefined,
    tags: row.tags ? JSON.parse(row.tags as string) : {},
    metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    contextId: (row.context_id as string) || undefined,
    suppressedUntil: (row.suppressed_until as string) || undefined,
    investigationStatus: (row.investigation_status as string) || undefined,
    investigationSummary: (row.investigation_summary as string) || undefined,
  };
}

export function getAlertById(id: string): NormalizedAlert | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAlert(row) : undefined;
}

export function getAlertsByFingerprint(
  fingerprint: string,
  limit = 20,
): NormalizedAlert[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM alerts WHERE fingerprint = ? ORDER BY received_at DESC LIMIT ?',
    )
    .all(fingerprint, limit) as Record<string, unknown>[];
  return rows.map(rowToAlert);
}

export function getAlertsByContext(contextId: string): NormalizedAlert[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM alerts WHERE context_id = ? ORDER BY received_at')
    .all(contextId) as Record<string, unknown>[];
  return rows.map(rowToAlert);
}

export function getRecentAlerts(since: string, limit = 50): NormalizedAlert[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM alerts WHERE received_at > ? ORDER BY received_at DESC LIMIT ?',
    )
    .all(since, limit) as Record<string, unknown>[];
  return rows.map(rowToAlert);
}

export function getPendingAlerts(): NormalizedAlert[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM alerts WHERE investigation_status IN ('pending', 'batching', 'investigating') AND severity <= 4 ORDER BY received_at ASC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToAlert);
}

export function updateAlertInvestigation(
  id: string,
  status: string,
  summary?: string,
  assessedPriority?: number,
): void {
  const db = getDb();
  const fields: string[] = ['investigation_status = ?'];
  const values: unknown[] = [status];

  if (summary !== undefined) {
    fields.push('investigation_summary = ?');
    values.push(summary);
  }
  if (assessedPriority !== undefined) {
    fields.push('assessed_priority = ?');
    values.push(assessedPriority);
  }

  values.push(id);
  db.prepare(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function setAlertContext(alertId: string, contextId: string): void {
  const db = getDb();
  db.prepare('UPDATE alerts SET context_id = ? WHERE id = ?').run(
    contextId,
    alertId,
  );
}

// --- FTS operations ---

export function indexAlertFts(alert: NormalizedAlert): void {
  const db = getDb();
  try {
    db.prepare(
      'INSERT INTO alert_fts (id, summary, description, type, resource) VALUES (?, ?, ?, ?, ?)',
    ).run(
      alert.id,
      alert.summary,
      alert.description || '',
      alert.type,
      alert.resource,
    );
  } catch (err) {
    logger.debug({ alertId: alert.id, err }, 'FTS index failed');
  }
}

export function searchAlertsFts(query: string, limit = 20): NormalizedAlert[] {
  const db = getDb();
  try {
    const rows = db
      .prepare(
        `SELECT a.* FROM alert_fts f
         JOIN alerts a ON a.id = f.id
         WHERE alert_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as Record<string, unknown>[];
    return rows.map(rowToAlert);
  } catch (err) {
    logger.debug({ query, err }, 'FTS search failed');
    return [];
  }
}

// --- Context CRUD ---

export function createAlertContext(
  id: string,
  alerts: NormalizedAlert[],
): AlertContext {
  const db = getDb();
  const now = new Date().toISOString();
  const primarySeverity = Math.min(...alerts.map((a) => a.severity));

  db.prepare(
    `INSERT INTO alert_contexts (id, created_at, status, alert_count, primary_severity)
     VALUES (?, ?, 'open', ?, ?)`,
  ).run(id, now, alerts.length, primarySeverity);

  return {
    id,
    createdAt: now,
    status: 'open',
    alertCount: alerts.length,
    primarySeverity,
  };
}

export function closeAlertContext(id: string, summary: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE alert_contexts SET status = 'closed', closed_at = ?, summary = ? WHERE id = ?`,
  ).run(now, summary, id);
}

export function getOpenAlertContexts(): AlertContext[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alert_contexts WHERE status != 'closed' ORDER BY created_at DESC`,
    )
    .all() as AlertContext[];
}

// --- Subscription CRUD ---

export function createSubscription(sub: AlertSubscription): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO alert_subscriptions (id, group_jid, group_folder, patterns, is_protected, created_by, min_severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sub.id,
    sub.groupJid,
    sub.groupFolder,
    JSON.stringify(sub.patterns),
    sub.isProtected ? 1 : 0,
    sub.createdBy,
    sub.minSeverity ?? null,
    sub.createdAt,
  );
}

function rowToSubscription(row: Record<string, unknown>): AlertSubscription {
  return {
    id: row.id as string,
    groupJid: row.group_jid as string,
    groupFolder: row.group_folder as string,
    patterns: JSON.parse(row.patterns as string),
    isProtected: (row.is_protected as number) === 1,
    createdBy: row.created_by as string,
    minSeverity: (row.min_severity as number) ?? undefined,
    createdAt: row.created_at as string,
  };
}

export function getSubscriptionsForGroup(
  groupJid: string,
): AlertSubscription[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM alert_subscriptions WHERE group_jid = ?')
    .all(groupJid) as Record<string, unknown>[];
  return rows.map(rowToSubscription);
}

export function getAllSubscriptions(): AlertSubscription[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM alert_subscriptions ORDER BY created_at')
    .all() as Record<string, unknown>[];
  return rows.map(rowToSubscription);
}

/**
 * Delete a subscription. Returns false if protected and requester isn't main.
 */
export function deleteSubscription(
  id: string,
  requesterIsMain: boolean,
): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT is_protected FROM alert_subscriptions WHERE id = ?')
    .get(id) as { is_protected: number } | undefined;

  if (!row) return true; // Already gone
  if (row.is_protected && !requesterIsMain) return false;

  db.prepare('DELETE FROM alert_subscriptions WHERE id = ?').run(id);
  return true;
}

// --- Subscription matching ---

/**
 * Simple glob match: * matches any sequence, ? matches one char.
 */
function globMatch(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(value);
}

function matchField(alert: NormalizedAlert, pattern: AlertPattern): boolean {
  let fieldValue: string;
  if (pattern.field.startsWith('tags.')) {
    const tagKey = pattern.field.slice(5);
    fieldValue = alert.tags[tagKey] ?? '';
  } else {
    fieldValue = String(
      (alert as unknown as Record<string, unknown>)[pattern.field] ?? '',
    );
  }

  switch (pattern.operator) {
    case 'eq':
      return fieldValue === pattern.value;
    case 'regex':
      try {
        return new RegExp(pattern.value, 'i').test(fieldValue);
      } catch {
        return false;
      }
    case 'glob':
      return globMatch(pattern.value, fieldValue);
    case 'lt':
      return Number(fieldValue) < Number(pattern.value);
    case 'gt':
      return Number(fieldValue) > Number(pattern.value);
    default:
      return false;
  }
}

/**
 * Find all subscriptions matching an alert.
 * A subscription matches if ALL its patterns match (AND logic).
 */
export function matchSubscriptions(
  alert: NormalizedAlert,
): AlertSubscription[] {
  const allSubs = getAllSubscriptions();
  return allSubs.filter((sub) => {
    // Check minSeverity filter
    if (sub.minSeverity !== undefined && alert.severity > sub.minSeverity)
      return false;
    // All patterns must match
    return sub.patterns.every((p) => matchField(alert, p));
  });
}

// --- Frequency tracking ---

export function getAlertFrequency(fingerprint: string): AlertFrequency {
  const db = getDb();
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const count24h = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM alerts WHERE fingerprint = ? AND received_at > ?',
      )
      .get(fingerprint, since24h) as { cnt: number }
  ).cnt;

  const count7d = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM alerts WHERE fingerprint = ? AND received_at > ?',
      )
      .get(fingerprint, since7d) as { cnt: number }
  ).cnt;

  const lastRow = db
    .prepare(
      'SELECT received_at FROM alerts WHERE fingerprint = ? ORDER BY received_at DESC LIMIT 1',
    )
    .get(fingerprint) as { received_at: string } | undefined;

  const suppression = db
    .prepare('SELECT * FROM alert_suppression_rules WHERE fingerprint = ?')
    .get(fingerprint) as
    | { suppressed_until: string | null; reason: string | null }
    | undefined;

  const isSuppressed =
    !!suppression &&
    (!suppression.suppressed_until ||
      new Date(suppression.suppressed_until) > now);

  return {
    fingerprint,
    count24h,
    count7d,
    lastSeen: lastRow?.received_at || '',
    isSuppressed,
    suppressedUntil: suppression?.suppressed_until || undefined,
    suppressionReason: suppression?.reason || undefined,
  };
}

export function isAlertSuppressed(fingerprint: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT suppressed_until FROM alert_suppression_rules WHERE fingerprint = ?',
    )
    .get(fingerprint) as { suppressed_until: string | null } | undefined;

  if (!row) return false;
  if (!row.suppressed_until) return true; // Indefinite suppression
  return new Date(row.suppressed_until) > new Date();
}

// --- Suppression ---

export function suppressAlert(
  fingerprint: string,
  until: string | null,
  reason: string,
  createdBy: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO alert_suppression_rules (fingerprint, suppressed_until, reason, created_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(fingerprint, until, reason, new Date().toISOString(), createdBy);
}

export function unsuppressAlert(fingerprint: string): void {
  const db = getDb();
  db.prepare('DELETE FROM alert_suppression_rules WHERE fingerprint = ?').run(
    fingerprint,
  );
}

// --- Correlation ---

/**
 * Find alerts correlated with a given alert by shared attributes in a time window.
 */
export function getCorrelatedAlerts(
  alert: NormalizedAlert,
  windowMinutes = 60,
  limit = 20,
): NormalizedAlert[] {
  const db = getDb();
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  // Score alerts by shared attributes. Wrap in subquery so the alias
  // correlation_score can be filtered in the outer WHERE clause.
  const rows = db
    .prepare(
      `SELECT * FROM (
        SELECT *,
          (CASE WHEN resource = ? THEN 2 ELSE 0 END) +
          (CASE WHEN host = ? THEN 2 ELSE 0 END) +
          (CASE WHEN location = ? THEN 1 ELSE 0 END) +
          (CASE WHEN type = ? THEN 1 ELSE 0 END) +
          (CASE WHEN environment = ? THEN 1 ELSE 0 END) +
          (CASE WHEN category = ? THEN 1 ELSE 0 END)
          AS correlation_score
        FROM alerts
        WHERE received_at > ?
          AND id != ?
      )
      WHERE correlation_score > 0
      ORDER BY correlation_score DESC, received_at DESC
      LIMIT ?`,
    )
    .all(
      alert.resource,
      alert.host || '',
      alert.location || '',
      alert.type,
      alert.environment || '',
      alert.category,
      since,
      alert.id,
      limit,
    ) as Record<string, unknown>[];

  return rows.map(rowToAlert);
}

// --- Knowledge ---

export function getAlertKnowledge(
  fingerprint: string,
): AlertKnowledge | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM alert_knowledge WHERE fingerprint = ?')
    .get(fingerprint) as Record<string, unknown> | undefined;

  if (!row) return undefined;
  return {
    fingerprint: row.fingerprint as string,
    alertType: row.alert_type as string,
    resourcePattern: (row.resource_pattern as string) || undefined,
    investigationCount: row.investigation_count as number,
    lastInvestigated: row.last_investigated as string,
    knowledge: row.knowledge as string,
    runbookUrl: (row.runbook_url as string) || undefined,
    typicalPriority: row.typical_priority as number,
    typicalResolution: (row.typical_resolution as string) || undefined,
    autoSuppress: (row.auto_suppress as number) === 1,
  };
}

export function upsertAlertKnowledge(
  fingerprint: string,
  alertType: string,
  resource: string,
  summary: string,
  priority: number,
): void {
  const db = getDb();
  const existing = getAlertKnowledge(fingerprint);
  const now = new Date().toISOString();

  if (existing) {
    const newCount = existing.investigationCount + 1;
    const avgPriority = Math.round(
      (existing.typicalPriority * existing.investigationCount + priority) /
        newCount,
    );
    const knowledge = existing.knowledge + `\n\n---\n[${now}] ${summary}`;

    db.prepare(
      `UPDATE alert_knowledge SET
        investigation_count = ?,
        last_investigated = ?,
        knowledge = ?,
        typical_priority = ?
      WHERE fingerprint = ?`,
    ).run(newCount, now, knowledge, avgPriority, fingerprint);
  } else {
    db.prepare(
      `INSERT INTO alert_knowledge (fingerprint, alert_type, resource_pattern, investigation_count, last_investigated, knowledge, typical_priority, auto_suppress)
       VALUES (?, ?, ?, 1, ?, ?, ?, 0)`,
    ).run(fingerprint, alertType, resource, now, summary, priority);
  }
}

// --- Maintenance ---

export function purgeOldAlerts(retentionDays = 90): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();

  const deleted = db
    .prepare(
      `DELETE FROM alerts WHERE received_at < ? AND investigation_status IN ('complete', 'suppressed')`,
    )
    .run(cutoff);

  // Clean up orphaned FTS entries
  try {
    db.exec('DELETE FROM alert_fts WHERE id NOT IN (SELECT id FROM alerts)');
  } catch {
    /* FTS cleanup failed — non-critical */
  }

  // Close old contexts
  db.prepare(
    `UPDATE alert_contexts SET status = 'closed', closed_at = ? WHERE created_at < ? AND status != 'closed'`,
  ).run(new Date().toISOString(), cutoff);

  return deleted.changes;
}

export function backupDatabase(backupDir: string, maxBackups = 7): void {
  const db = getDb();
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `messages-${timestamp}.db`);

  try {
    db.exec(`VACUUM INTO '${backupPath}'`);
    logger.info({ backupPath }, 'Database backup created');

    // Prune old backups
    const backups = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('messages-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const old of backups.slice(maxBackups)) {
      fs.unlinkSync(path.join(backupDir, old));
      logger.info({ file: old }, 'Old backup pruned');
    }
  } catch (err) {
    logger.error({ err }, 'Database backup failed');
  }
}
