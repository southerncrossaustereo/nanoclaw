import { NormalizedAlert } from './alert-types.js';

/**
 * Normalize an Azure Monitor Common Alert Schema payload.
 * https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-common-schema
 */
export function normalizeAzureMonitor(
  payload: Record<string, unknown>,
): Partial<NormalizedAlert> {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) throw new Error('Missing data field in Azure Monitor payload');

  const essentials = data.essentials as Record<string, unknown> | undefined;
  if (!essentials) throw new Error('Missing data.essentials in Azure Monitor payload');

  // Map Azure severity: Sev0→1, Sev1→2, Sev2→3, Sev3→4, Sev4→5
  const azureSev = String(essentials.severity || 'Sev4');
  const sevMap: Record<string, number> = {
    Sev0: 1,
    Sev1: 2,
    Sev2: 3,
    Sev3: 4,
    Sev4: 5,
  };
  const severity = sevMap[azureSev] ?? 4;

  // Map monitor condition to status
  const condition = String(essentials.monitorCondition || '');
  const statusMap: Record<string, string> = {
    Fired: 'firing',
    Resolved: 'resolved',
  };
  const status = statusMap[condition] || 'firing';

  // Extract resource info
  const targetResourceName = String(essentials.targetResourceName || '');
  const targetResourceType = String(essentials.targetResourceType || '');
  const targetResourceGroup = String(essentials.targetResourceGroup || '');

  // Simplify Azure resource type (e.g. "Microsoft.Compute/virtualMachines" → "vm")
  const resourceTypeMap: Record<string, string> = {
    'microsoft.compute/virtualmachines': 'vm',
    'microsoft.web/sites': 'webapp',
    'microsoft.sql/servers/databases': 'database',
    'microsoft.storage/storageaccounts': 'storage',
    'microsoft.network/loadbalancers': 'network',
    'microsoft.containerservice/managedclusters': 'container',
    'microsoft.web/serverfarms': 'app-service-plan',
  };
  const resourceType =
    resourceTypeMap[targetResourceType.toLowerCase()] || targetResourceType;

  // Extract alert context for metric/log details
  const alertContext = data.alertContext as Record<string, unknown> | undefined;
  let metricValue: string | undefined;
  let threshold: string | undefined;
  let description: string | undefined;

  if (alertContext) {
    // Metric alerts
    const condition2 = alertContext.condition as Record<string, unknown> | undefined;
    if (condition2?.allOf) {
      const criteria = (condition2.allOf as Record<string, unknown>[])[0];
      if (criteria) {
        metricValue = criteria.metricValue != null ? String(criteria.metricValue) : undefined;
        threshold = criteria.threshold != null ? String(criteria.threshold) : undefined;
      }
    }
    description = (alertContext.conditionType as string) || undefined;
  }

  // Build tags from essentials
  const tags: Record<string, string> = {};
  if (targetResourceGroup) tags.resourceGroup = targetResourceGroup;
  if (essentials.monitoringService)
    tags.monitoringService = String(essentials.monitoringService);

  // Try to infer environment from resource name or tags
  let environment: string | undefined;
  const nameLower = targetResourceName.toLowerCase();
  if (nameLower.includes('prod')) environment = 'production';
  else if (nameLower.includes('stag')) environment = 'staging';
  else if (nameLower.includes('dev')) environment = 'development';

  return {
    externalId: String(essentials.alertId || ''),
    source: 'azure-monitor',
    sourceUrl: String(essentials.alertId || ''),
    type: String(essentials.alertRule || 'Unknown Azure Alert'),
    category: 'infrastructure',
    severity,
    status,
    resource: targetResourceName,
    resourceType,
    location: String(essentials.targetResourceRegion || '') || undefined,
    environment,
    firedAt: String(essentials.firedDateTime || new Date().toISOString()),
    summary: String(
      essentials.description || essentials.alertRule || 'Azure Monitor Alert',
    ),
    description,
    metricValue,
    threshold,
    tags,
    metadata: payload,
  };
}

/**
 * Normalize a Jira Service Management webhook payload.
 */
export function normalizeJiraSM(
  payload: Record<string, unknown>,
): Partial<NormalizedAlert> {
  const webhookEvent = String(payload.webhookEvent || '');
  const issue = payload.issue as Record<string, unknown> | undefined;

  if (!issue) throw new Error('Missing issue field in Jira SM payload');

  const fields = issue.fields as Record<string, unknown> | undefined;
  if (!fields) throw new Error('Missing issue.fields in Jira SM payload');

  const key = String(issue.key || '');
  const summary = String(fields.summary || 'Jira Issue');

  // Map Jira priority to severity: P1→1, P2→2, etc.
  const priority = fields.priority as Record<string, unknown> | undefined;
  const priorityName = String(priority?.name || 'Medium');
  const prioMap: Record<string, number> = {
    Highest: 1,
    High: 2,
    Medium: 3,
    Low: 4,
    Lowest: 5,
  };
  // Also handle P1-P5 naming
  const severity =
    prioMap[priorityName] ??
    (/^P?(\d)$/i.test(priorityName) ? parseInt(priorityName.replace(/^P/i, '')) : 3);

  // Map webhook event to status
  let status = 'firing';
  if (webhookEvent.includes('deleted') || webhookEvent.includes('resolved')) {
    status = 'resolved';
  }

  const issueType = fields.issuetype as Record<string, unknown> | undefined;
  const type = String(issueType?.name || 'Service Request');

  // Determine category from issue type
  let category = 'service-desk';
  const typeLower = type.toLowerCase();
  if (typeLower.includes('incident')) category = 'infrastructure';
  else if (typeLower.includes('security')) category = 'security';
  else if (typeLower.includes('deploy') || typeLower.includes('change'))
    category = 'deployment';

  // Build tags from labels and components
  const tags: Record<string, string> = {};
  const labels = fields.labels as string[] | undefined;
  if (labels?.length) tags.labels = labels.join(',');
  const components = fields.components as
    | Array<{ name: string }>
    | undefined;
  if (components?.length) tags.components = components.map((c) => c.name).join(',');
  const project = fields.project as Record<string, unknown> | undefined;
  if (project?.key) tags.project = String(project.key);

  // Use the Jira site URL for sourceUrl
  const self = String(issue.self || '');
  const siteMatch = self.match(/^(https?:\/\/[^/]+)/);
  const sourceUrl = siteMatch ? `${siteMatch[1]}/browse/${key}` : undefined;

  return {
    externalId: key,
    source: 'jira-sm',
    sourceUrl,
    type,
    category,
    severity,
    status,
    resource: key,
    firedAt: String(fields.created || new Date().toISOString()),
    summary,
    description: String(fields.description || '') || undefined,
    tags,
    metadata: payload,
  };
}

/**
 * Normalize a generic pre-normalized alert payload.
 * Validates required fields and fills defaults for missing optionals.
 */
export function normalizeGeneric(
  payload: Record<string, unknown>,
): Partial<NormalizedAlert> {
  if (!payload.type) throw new Error('Missing required field: type');
  if (!payload.resource) throw new Error('Missing required field: resource');
  if (!payload.summary) throw new Error('Missing required field: summary');

  const severity = Number(payload.severity ?? 3);
  if (severity < 1 || severity > 5)
    throw new Error('severity must be 1-5');

  return {
    externalId: String(payload.externalId || ''),
    source: String(payload.source || 'generic'),
    sourceUrl: payload.sourceUrl ? String(payload.sourceUrl) : undefined,
    type: String(payload.type),
    category: String(payload.category || 'infrastructure'),
    severity,
    status: String(payload.status || 'firing'),
    resource: String(payload.resource),
    resourceType: payload.resourceType
      ? String(payload.resourceType)
      : undefined,
    host: payload.host ? String(payload.host) : undefined,
    hostType: payload.hostType ? String(payload.hostType) : undefined,
    location: payload.location ? String(payload.location) : undefined,
    environment: payload.environment ? String(payload.environment) : undefined,
    firedAt: String(payload.firedAt || new Date().toISOString()),
    summary: String(payload.summary),
    description: payload.description ? String(payload.description) : undefined,
    metricValue: payload.metricValue ? String(payload.metricValue) : undefined,
    threshold: payload.threshold ? String(payload.threshold) : undefined,
    tags: (payload.tags as Record<string, string>) || {},
    metadata: payload,
  };
}
