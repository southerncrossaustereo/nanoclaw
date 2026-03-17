import { createHash } from 'crypto';

/**
 * Compute a deterministic fingerprint for an alert.
 * Same fingerprint = same alert type/resource, different occurrence.
 * Excludes severity (can escalate), timestamps, metric values, description.
 */
export function computeFingerprint(alert: {
  source: string;
  type: string;
  resource: string;
  host?: string;
  location?: string;
}): string {
  const key = `${alert.source}|${alert.type}|${alert.resource}|${alert.host || ''}|${alert.location || ''}`;
  return createHash('sha256').update(key).digest('hex');
}
