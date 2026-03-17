import { ChildProcess } from 'child_process';

import { ASSISTANT_NAME } from './config.js';
import {
  getAlertsByContext,
  getAlertFrequency,
  getCorrelatedAlerts,
  getAlertKnowledge,
  updateAlertInvestigation,
  closeAlertContext,
  upsertAlertKnowledge,
  getAllSubscriptions,
} from './alert-db.js';
import { NormalizedAlert } from './alert-types.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
  writeSubscriptionsSnapshot,
} from './container-runner.js';
import { getAllTasks, setSession } from './db.js';
import { GroupQueue } from './group-queue.js';
import { setOnBatchReady } from './alert-ingestion.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface AlertProcessorDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSessions: (folder: string, sessionId: string) => void;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainGroup: () => { jid: string; group: RegisteredGroup } | null;
}

export function startAlertProcessor(deps: AlertProcessorDependencies): void {
  setOnBatchReady((alerts, contextId) => {
    processAlertBatch(alerts, contextId, deps).catch((err) =>
      logger.error({ err, contextId }, 'Alert batch processing failed'),
    );
  });
  logger.info('Alert processor started');
}

async function processAlertBatch(
  alerts: NormalizedAlert[],
  contextId: string,
  deps: AlertProcessorDependencies,
): Promise<void> {
  const mainGroup = deps.getMainGroup();
  if (!mainGroup) {
    logger.error('No main group configured — cannot process alerts');
    return;
  }

  const investigable = alerts.filter((a) => a.severity <= 4);
  const infoAlerts = alerts.filter((a) => a.severity >= 5);

  if (investigable.length === 0) return;

  // Gather context
  const relatedAlerts = getCorrelatedAlerts(investigable[0], 60, 20);
  const frequencyData = investigable.map((a) => ({
    type: a.type,
    fingerprint: a.fingerprint,
    frequency: getAlertFrequency(a.fingerprint),
  }));

  // Gather prior knowledge
  const knowledgeEntries = investigable
    .map((a) => getAlertKnowledge(a.fingerprint))
    .filter((k): k is NonNullable<typeof k> => k != null);

  const prompt = buildInvestigationPrompt(
    investigable,
    infoAlerts,
    relatedAlerts,
    frequencyData,
    knowledgeEntries,
    contextId,
  );

  // Mark alerts as investigating
  for (const a of investigable) {
    updateAlertInvestigation(a.id, 'investigating');
  }

  logger.info(
    {
      contextId,
      alertCount: investigable.length,
      infoCount: infoAlerts.length,
      relatedCount: relatedAlerts.length,
    },
    'Dispatching alert investigation',
  );

  // Enqueue to the main group's container
  deps.queue.enqueueTask(
    mainGroup.jid,
    `alert-${contextId}`,
    () => runAlertInvestigation(mainGroup.group, prompt, mainGroup.jid, contextId, deps),
  );
}

async function runAlertInvestigation(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  contextId: string,
  deps: AlertProcessorDependencies,
): Promise<void> {
  const isMain = true;
  // Alert investigations always use isolated sessions
  const sessionId = undefined;

  // Update snapshots for container to read
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const subs = getAllSubscriptions();
  writeSubscriptionsSnapshot(
    group.folder,
    isMain,
    subs.map((s) => ({
      id: s.id,
      groupJid: s.groupJid,
      groupFolder: s.groupFolder,
      patterns: s.patterns,
      isProtected: s.isProtected,
      minSeverity: s.minSeverity,
      createdAt: s.createdAt,
    })),
  );

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isScheduledTask: true, // Treat like a task — single-turn
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(chatJid, proc, containerName, group.folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.newSessionId) {
          deps.setSessions(group.folder, streamedOutput.newSessionId);
          setSession(group.folder, streamedOutput.newSessionId);
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(chatJid);
        }
      },
    );

    if (output.newSessionId) {
      deps.setSessions(group.folder, output.newSessionId);
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { contextId, error: output.error },
        'Alert investigation container error',
      );
    }
  } catch (err) {
    logger.error({ contextId, err }, 'Alert investigation failed');
  }
}

function buildInvestigationPrompt(
  investigable: NormalizedAlert[],
  infoAlerts: NormalizedAlert[],
  relatedAlerts: NormalizedAlert[],
  frequencyData: Array<{
    type: string;
    fingerprint: string;
    frequency: ReturnType<typeof getAlertFrequency>;
  }>,
  knowledgeEntries: Array<NonNullable<ReturnType<typeof getAlertKnowledge>>>,
  contextId: string,
): string {
  let prompt = `[ALERT INVESTIGATION - Context ${contextId}]

You are investigating ${investigable.length} alert(s) that arrived within the same time window.

<alerts>
${investigable
  .map(
    (a) => `
<alert id="${a.id}" severity="${a.severity}" source="${a.source}">
  <type>${a.type}</type>
  <resource>${a.resource}</resource>
  <host>${a.host || 'unknown'}</host>
  <environment>${a.environment || 'unknown'}</environment>
  <location>${a.location || 'unknown'}</location>
  <summary>${a.summary}</summary>
  <description>${a.description || ''}</description>
  <metric_value>${a.metricValue || 'N/A'}</metric_value>
  <threshold>${a.threshold || 'N/A'}</threshold>
  <fired_at>${a.firedAt}</fired_at>
  <source_url>${a.sourceUrl || ''}</source_url>
  <tags>${JSON.stringify(a.tags)}</tags>
</alert>`,
  )
  .join('\n')}
</alerts>`;

  if (infoAlerts.length > 0) {
    prompt += `

<info_context>
${infoAlerts.length} info-level (sev 5) alerts arrived in the same window:
${infoAlerts.map((a) => `- ${a.type}: ${a.summary} (${a.resource})`).join('\n')}
These may provide additional context for your investigation.
</info_context>`;
  }

  if (relatedAlerts.length > 0) {
    prompt += `

<recent_related_alerts>
${relatedAlerts
  .map(
    (a) =>
      `- [${a.receivedAt}] ${a.type}: ${a.summary} (sev ${a.severity}, ${a.investigationStatus}${a.investigationSummary ? ' — ' + a.investigationSummary.slice(0, 200) : ''})`,
  )
  .join('\n')}
</recent_related_alerts>`;
  }

  prompt += `

<frequency_data>
${frequencyData.map((f) => `- ${f.type}: ${f.frequency.count24h} in last 24h, ${f.frequency.count7d} in last 7d`).join('\n')}
</frequency_data>`;

  if (knowledgeEntries.length > 0) {
    prompt += `

<prior_knowledge>
${knowledgeEntries
  .map(
    (k) =>
      `Alert type: ${k.alertType}
Investigated ${k.investigationCount} times, last: ${k.lastInvestigated}
Typical priority: P${k.typicalPriority}
${k.runbookUrl ? 'Runbook: ' + k.runbookUrl : ''}
Prior findings:
${k.knowledge.slice(-2000)}`,
  )
  .join('\n---\n')}
</prior_knowledge>`;
  }

  prompt += `

## Investigation Instructions

1. **Assess relatedness**: Determine if the alerts in this batch are related (same root cause) or independent. If unrelated, use the Task tool to spin off independent sub-agents for each unrelated alert group, providing them with the relevant alert details and any context you've already gathered.

2. **Investigate root cause**: Use available tools:
   - \`az\` CLI for Azure resource status, metrics, logs, activity log
   - \`acli\` for Jira/Confluence — search for known issues, runbooks, past incidents
   - \`WebSearch\` for error messages, known issues, CVEs
   - \`WebFetch\` to check status pages or documentation

3. **Assess priority**: After investigation, assign an assessed priority (1-5) considering:
   - Severity of the alert(s)
   - Environment (production > staging > dev)
   - Blast radius (how many users/services affected)
   - Whether this is a known/recurring issue

4. **Report findings**: Use \`send_message\` to communicate your findings. Structure as:
   - One-line headline with assessed priority
   - What happened (symptoms)
   - Why it happened (root cause if determined)
   - Impact assessment
   - Recommended actions
   - Related historical context if relevant

5. **Write investigation summary**: After reporting, write a JSON file to /workspace/ipc/tasks/ with:
\`\`\`json
{
  "type": "alert_investigation_complete",
  "contextId": "${contextId}",
  "assessedPriority": <1-5>,
  "summary": "<brief investigation summary for knowledge base>",
  "alertIds": ["<ids of all investigated alerts>"]
}
\`\`\`
`;

  return prompt;
}

/**
 * Handle an alert_investigation_complete IPC message.
 * Called from ipc.ts when this message type is received.
 */
export function handleInvestigationComplete(
  data: {
    contextId: string;
    assessedPriority?: number;
    summary?: string;
    alertIds?: string[];
  },
  deps: { sendMessage: (jid: string, text: string) => Promise<void> },
): void {
  const { contextId, assessedPriority, summary, alertIds } = data;
  const priority = assessedPriority ?? 3;

  // Update all alerts in this context with findings
  const alerts = alertIds
    ? getAlertsByContext(contextId).filter((a) => alertIds.includes(a.id))
    : getAlertsByContext(contextId);

  for (const alert of alerts) {
    updateAlertInvestigation(alert.id, 'complete', summary, priority);
    // Update knowledge base
    if (summary) {
      upsertAlertKnowledge(
        alert.fingerprint,
        alert.type,
        alert.resource,
        summary,
        priority,
      );
    }
  }

  // Close the context
  closeAlertContext(contextId, summary || 'Investigation complete');

  // Notify subscribed groups
  notifySubscribedGroups(contextId, deps).catch((err) =>
    logger.error({ err, contextId }, 'Failed to notify subscribed groups'),
  );

  logger.info(
    { contextId, priority, alertCount: alerts.length },
    'Alert investigation complete',
  );
}

async function notifySubscribedGroups(
  contextId: string,
  deps: { sendMessage: (jid: string, text: string) => Promise<void> },
): Promise<void> {
  const alerts = getAlertsByContext(contextId);
  if (alerts.length === 0) return;

  const allSubs = getAllSubscriptions();

  // Find unique groups that should be notified
  const groupsToNotify = new Set<string>();

  for (const sub of allSubs) {
    // Check if ANY alert in the context matches ALL patterns
    const matches = alerts.some((alert) => {
      // Check minSeverity
      if (sub.minSeverity !== undefined && alert.severity > sub.minSeverity)
        return false;
      return sub.patterns.every((p) => {
        let fieldValue: string;
        if (p.field.startsWith('tags.')) {
          fieldValue = alert.tags[p.field.slice(5)] ?? '';
        } else {
          fieldValue = String(
            (alert as unknown as Record<string, unknown>)[p.field] ?? '',
          );
        }
        switch (p.operator) {
          case 'eq':
            return fieldValue === p.value;
          case 'regex':
            try {
              return new RegExp(p.value, 'i').test(fieldValue);
            } catch {
              return false;
            }
          case 'glob': {
            const regex = p.value
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.');
            return new RegExp(`^${regex}$`, 'i').test(fieldValue);
          }
          case 'lt':
            return Number(fieldValue) < Number(p.value);
          case 'gt':
            return Number(fieldValue) > Number(p.value);
          default:
            return false;
        }
      });
    });

    if (matches) {
      groupsToNotify.add(sub.groupJid);
    }
  }

  if (groupsToNotify.size === 0) {
    logger.info({ contextId }, 'No subscribed groups match this alert context');
    return;
  }

  // Build notification
  const primaryAlert = alerts.reduce(
    (min, a) => (a.severity < min.severity ? a : min),
    alerts[0],
  );
  const priority = primaryAlert.assessedPriority || primaryAlert.severity;
  const priorityLabel = ['', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'][
    priority
  ] || 'UNKNOWN';

  const alertList = alerts
    .filter((a) => a.severity <= 4)
    .map((a) => `- ${a.type} — ${a.resource} (sev ${a.severity})`)
    .join('\n');

  const summary =
    primaryAlert.investigationSummary || primaryAlert.summary;

  const notification = `Alert Investigation [P${priority} ${priorityLabel}]

${alertList}

${summary}${primaryAlert.sourceUrl ? '\n\nSource: ' + primaryAlert.sourceUrl : ''}`;

  // Send to each matched group
  for (const groupJid of groupsToNotify) {
    try {
      await deps.sendMessage(groupJid, notification);
      logger.info({ groupJid, contextId }, 'Alert notification sent');
    } catch (err) {
      logger.error(
        { groupJid, contextId, err },
        'Failed to send alert notification',
      );
    }
  }
}
