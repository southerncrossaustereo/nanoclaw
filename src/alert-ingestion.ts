import { randomUUID } from 'crypto';

import { ALERT_BATCH_WINDOW_MS, ALERT_NOISY_THRESHOLD_24H } from './config.js';
import { NormalizedAlert } from './alert-types.js';
import { computeFingerprint } from './alert-fingerprint.js';
import {
  insertAlert,
  indexAlertFts,
  getAlertFrequency,
  isAlertSuppressed,
  suppressAlert,
  updateAlertInvestigation,
  setAlertContext,
  createAlertContext,
} from './alert-db.js';
import { logger } from './logger.js';

interface BatchedAlerts {
  alerts: NormalizedAlert[];
  timer: ReturnType<typeof setTimeout>;
  contextId: string;
}

export type OnBatchReady = (
  alerts: NormalizedAlert[],
  contextId: string,
) => void;

let currentBatch: BatchedAlerts | null = null;
let batchCallback: OnBatchReady | null = null;

export function setOnBatchReady(cb: OnBatchReady): void {
  batchCallback = cb;
}

/**
 * Ingest a normalized alert.
 *
 * 1. Assign ID, fingerprint, receivedAt
 * 2. Check suppression (noisy alert)
 * 3. Store in DB + FTS index
 * 4. Add to batch buffer
 * 5. If batch window not started, start it
 */
export function ingestAlert(
  partial: Partial<NormalizedAlert>,
): NormalizedAlert {
  const now = new Date().toISOString();
  const alert: NormalizedAlert = {
    id: randomUUID(),
    receivedAt: now,
    fingerprint: computeFingerprint(partial as {
      source: string;
      type: string;
      resource: string;
      host?: string;
      location?: string;
    }),
    investigationStatus: 'pending',
    tags: partial.tags || {},
    metadata: partial.metadata || {},
    externalId: partial.externalId || '',
    source: partial.source || 'unknown',
    type: partial.type || 'unknown',
    category: partial.category || 'infrastructure',
    severity: partial.severity ?? 3,
    status: partial.status || 'firing',
    resource: partial.resource || 'unknown',
    firedAt: partial.firedAt || now,
    summary: partial.summary || 'Alert',
    ...partial,
  } as NormalizedAlert;

  // Store immediately (even if suppressed — for frequency tracking)
  insertAlert(alert);
  indexAlertFts(alert);

  // Check suppression
  if (isAlertSuppressed(alert.fingerprint)) {
    updateAlertInvestigation(
      alert.id,
      'suppressed',
      'Auto-suppressed: noisy alert',
    );
    logger.info(
      { fingerprint: alert.fingerprint, type: alert.type },
      'Alert suppressed (noisy)',
    );
    return alert;
  }

  // Check frequency-based auto-suppression
  const freq = getAlertFrequency(alert.fingerprint);
  if (freq.count24h >= ALERT_NOISY_THRESHOLD_24H) {
    const until = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();
    suppressAlert(
      alert.fingerprint,
      until,
      `Auto-suppressed: ${freq.count24h} occurrences in 24h`,
      'system',
    );
    updateAlertInvestigation(
      alert.id,
      'suppressed',
      `Auto-suppressed: ${freq.count24h} occurrences in 24h`,
    );
    logger.warn(
      { fingerprint: alert.fingerprint, count: freq.count24h },
      'Alert auto-suppressed (noisy threshold)',
    );
    return alert;
  }

  // Add to batch
  addToBatch(alert);

  return alert;
}

function addToBatch(alert: NormalizedAlert): void {
  if (!currentBatch) {
    const contextId = randomUUID();
    currentBatch = {
      alerts: [],
      contextId,
      timer: setTimeout(() => flushBatch(), ALERT_BATCH_WINDOW_MS),
    };
    logger.info(
      { contextId, windowMs: ALERT_BATCH_WINDOW_MS },
      'New alert batch window opened',
    );
  }

  alert.investigationStatus = 'batching';
  alert.contextId = currentBatch.contextId;
  setAlertContext(alert.id, currentBatch.contextId);
  updateAlertInvestigation(alert.id, 'batching');

  currentBatch.alerts.push(alert);
}

function flushBatch(): void {
  if (!currentBatch || currentBatch.alerts.length === 0) {
    currentBatch = null;
    return;
  }

  const batch = currentBatch;
  currentBatch = null;

  // Separate sev 5 (info-only) from investigable alerts
  const investigable = batch.alerts.filter((a) => a.severity <= 4);
  const infoOnly = batch.alerts.filter((a) => a.severity >= 5);

  if (investigable.length === 0) {
    logger.info(
      { contextId: batch.contextId, infoCount: infoOnly.length },
      'Batch contains only info alerts, skipping investigation',
    );
    for (const a of infoOnly) {
      updateAlertInvestigation(
        a.id,
        'complete',
        'Info-only alert, no investigation required',
      );
    }
    return;
  }

  logger.info(
    {
      contextId: batch.contextId,
      investigable: investigable.length,
      infoContext: infoOnly.length,
    },
    'Batch ready for investigation',
  );

  // Create the context record
  createAlertContext(batch.contextId, investigable);

  // Callback to alert processor
  if (batchCallback) {
    batchCallback(batch.alerts, batch.contextId);
  }
}

/** For testing: force-flush the current batch. */
export function _flushBatchForTests(): void {
  if (currentBatch?.timer) clearTimeout(currentBatch.timer);
  flushBatch();
}
