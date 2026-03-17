export interface NormalizedAlert {
  id: string;
  fingerprint: string;
  externalId: string;
  source: string;
  sourceUrl?: string;
  type: string;
  category: string;
  severity: number; // 1-5 (1=critical, 5=informational)
  assessedPriority?: number; // 1-5, set by investigation agent
  status: string; // 'firing' | 'resolved' | 'acknowledged'
  resource: string;
  resourceType?: string;
  host?: string;
  hostType?: string;
  location?: string;
  environment?: string;
  firedAt: string;
  receivedAt: string;
  resolvedAt?: string;
  summary: string;
  description?: string;
  metricValue?: string;
  threshold?: string;
  tags: Record<string, string>;
  metadata: Record<string, unknown>;
  contextId?: string;
  suppressedUntil?: string;
  investigationStatus?: string; // 'pending' | 'batching' | 'investigating' | 'complete' | 'suppressed'
  investigationSummary?: string;
}

export interface AlertContext {
  id: string;
  createdAt: string;
  closedAt?: string;
  status: string; // 'open' | 'investigating' | 'closed'
  summary?: string;
  alertCount: number;
  primarySeverity: number;
}

export interface AlertPattern {
  field: string; // 'severity' | 'resource' | 'type' | 'category' | 'host' | 'environment' | 'location' | 'tags.{key}'
  operator: string; // 'eq' | 'regex' | 'glob' | 'lt' | 'gt'
  value: string;
}

export interface AlertSubscription {
  id: string;
  groupJid: string;
  groupFolder: string;
  patterns: AlertPattern[];
  isProtected: boolean;
  createdBy: string; // 'self' | group folder of creator
  minSeverity?: number; // Only alerts with severity <= this (1=most severe)
  createdAt: string;
}

export interface AlertFrequency {
  fingerprint: string;
  count24h: number;
  count7d: number;
  lastSeen: string;
  isSuppressed: boolean;
  suppressedUntil?: string;
  suppressionReason?: string;
}

export interface AlertKnowledge {
  fingerprint: string;
  alertType: string;
  resourcePattern?: string;
  investigationCount: number;
  lastInvestigated: string;
  knowledge: string;
  runbookUrl?: string;
  typicalPriority: number;
  typicalResolution?: string;
  autoSuppress: boolean;
}
