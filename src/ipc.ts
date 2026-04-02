import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { randomUUID } from 'crypto';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup, loadGithubAppToken } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import {
  createSubscription,
  deleteSubscription,
  getAlertsByFingerprint,
  getRecentAlerts,
  searchAlertsFts,
} from './alert-db.js';
import { handleInvestigationComplete } from './alert-processor.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendCard?: (jid: string, card: object) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  clearSession: (groupFolder: string, summary?: string) => void;
  getSession: (groupFolder: string) => string | undefined;
  setSession: (groupFolder: string, sessionId: string) => void;
  getSessionHistory: (
    groupFolder: string,
    limit?: number,
  ) => Array<{
    id: number;
    session_id: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    summary: string | null;
    message_count: number;
  }>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Move conversation archives from IPC to the protected group conversations dir
      const conversationsIpcDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'conversations',
      );
      try {
        if (fs.existsSync(conversationsIpcDir)) {
          const convFiles = fs
            .readdirSync(conversationsIpcDir)
            .filter((f) => f.endsWith('.md'));
          for (const file of convFiles) {
            const srcPath = path.join(conversationsIpcDir, file);
            const groupDir = resolveGroupFolderPath(sourceGroup);
            const dstDir = path.join(groupDir, 'conversations');
            fs.mkdirSync(dstDir, { recursive: true });
            const dstPath = path.join(dstDir, file);
            try {
              fs.renameSync(srcPath, dstPath);
            } catch {
              // Cross-device: copy then delete
              fs.copyFileSync(srcPath, dstPath);
              fs.unlinkSync(srcPath);
            }
            logger.debug(
              { file, sourceGroup },
              'Conversation archive moved to protected dir',
            );
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error processing IPC conversations',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For alert investigation
    contextId?: string;
    assessedPriority?: number;
    summary?: string;
    alertIds?: string[];
  } & Record<string, unknown>,
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups need scheduledTasksAccess permission
        if (
          !isMain &&
          !targetGroupEntry.containerConfig?.scheduledTasksAccess
        ) {
          logger.warn(
            { sourceGroup, targetFolder },
            'schedule_task blocked: group lacks scheduledTasksAccess permission',
          );
          break;
        }

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'alert_investigation_complete':
      if (data.contextId) {
        handleInvestigationComplete(
          {
            contextId: data.contextId as string,
            assessedPriority: data.assessedPriority as number | undefined,
            summary: data.summary as string | undefined,
            alertIds: data.alertIds as string[] | undefined,
          },
          { sendMessage: deps.sendMessage },
        );
        logger.info(
          { contextId: data.contextId, sourceGroup },
          'Alert investigation complete IPC processed',
        );
      }
      break;

    case 'alert_subscribe': {
      const subGroupJid = (data as any).groupJid as string;
      const patterns = (data as any).patterns;
      if (!subGroupJid || !patterns) {
        logger.warn({ data }, 'Invalid alert_subscribe request');
        break;
      }

      // Resolve group folder from JID if needed
      const subTargetGroup = registeredGroups[subGroupJid];
      const subGroupFolder =
        (data as any).groupFolder || subTargetGroup?.folder || sourceGroup;

      const subId = randomUUID();
      createSubscription({
        id: subId,
        groupJid: subGroupJid,
        groupFolder: subGroupFolder,
        patterns,
        isProtected: (data as any).isProtected === true,
        createdBy: (data as any).createdBy || sourceGroup,
        minSeverity: (data as any).minSeverity,
        createdAt: new Date().toISOString(),
      });
      logger.info(
        { subId, groupJid: subGroupJid, sourceGroup },
        'Alert subscription created via IPC',
      );
      break;
    }

    case 'alert_unsubscribe': {
      const subIdToDelete = (data as any).subscriptionId as string;
      if (!subIdToDelete) {
        logger.warn({ data }, 'Invalid alert_unsubscribe request');
        break;
      }
      const deleted = deleteSubscription(subIdToDelete, isMain);
      if (!deleted) {
        logger.warn(
          { subId: subIdToDelete, sourceGroup },
          'Cannot delete protected subscription (not main)',
        );
      } else {
        logger.info(
          { subId: subIdToDelete, sourceGroup },
          'Alert subscription deleted via IPC',
        );
      }
      break;
    }

    case 'alert_suppress': {
      const { suppressAlert } = await import('./alert-db.js');
      const fp = (data as any).fingerprint as string;
      const hours = (data as any).durationHours as number;
      const reason = (data as any).reason as string;
      if (!fp || !reason) {
        logger.warn({ data }, 'Invalid alert_suppress request');
        break;
      }
      const until =
        hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : null;
      suppressAlert(fp, until, reason, sourceGroup);
      logger.info(
        { fingerprint: fp, hours, sourceGroup },
        'Alert suppression created via IPC',
      );
      break;
    }

    case 'refresh_github_token': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'refresh_github_token missing requestId');
        break;
      }
      try {
        const token = await loadGithubAppToken(true);
        if (!token) {
          logger.warn(
            { sourceGroup },
            'GitHub App token generation failed during refresh',
          );
          break;
        }
        // Write response file for the agent to pick up
        const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup);
        const responsePath = path.join(
          responseDir,
          `github-token-${requestId}.json`,
        );
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ token }));
        fs.renameSync(tempPath, responsePath);
        logger.info(
          { sourceGroup, requestId },
          'GitHub App token refreshed via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error refreshing GitHub App token');
      }
      break;
    }

    case 'request_tool_access': {
      // Non-main groups request tool access — forward to main group as a message
      if (isMain) {
        logger.warn(
          { sourceGroup },
          'Main group sent request_tool_access — ignored',
        );
        break;
      }

      const tool = data.tool as string;
      const reason = data.reason as string;
      const requestChatJid = data.chatJid as string;
      if (!tool || !reason) {
        logger.warn({ data }, 'Invalid request_tool_access — missing fields');
        break;
      }

      // Find the main group's JID
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn('No main group registered — cannot forward tool request');
        break;
      }
      const [mainJid] = mainEntry;

      // Look up requesting group name
      const requestingGroup = registeredGroups[requestChatJid];
      const groupName = requestingGroup?.name || sourceGroup;

      // Query recent participants from messages table
      const { getRecentParticipants } = await import('./db.js');
      const participants = getRecentParticipants(requestChatJid);

      const toolNames: Record<string, string> = {
        azure: 'Azure CLI (`azureAccess`)',
        github: 'GitHub CLI (`githubAccess`)',
        atlassian: 'Atlassian API (`atlassianAccess`)',
        scheduled_tasks: 'Scheduled Tasks (`scheduledTasksAccess`)',
      };

      // Determine the config flag for approval instructions
      const configFlag = `"${tool === 'scheduled_tasks' ? 'scheduledTasks' : tool}Access": true`;

      const membersText =
        participants.length > 0
          ? participants.join(', ')
          : '(no recent activity)';

      if (deps.sendCard && mainJid.startsWith('teams:')) {
        const card = {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: 'Tool Access Request',
              weight: 'Bolder',
              size: 'Large',
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Group', value: groupName },
                { title: 'Tool', value: toolNames[tool] || tool },
                { title: 'Reason', value: reason },
                { title: 'Members', value: membersText },
              ],
            },
          ],
          actions: [
            {
              type: 'Action.Execute',
              title: 'Approve',
              verb: 'approve_tool_access',
              data: { requestJid: requestChatJid, tool },
            },
            {
              type: 'Action.Execute',
              title: 'Deny',
              verb: 'deny_tool_access',
              data: { requestJid: requestChatJid, tool },
            },
          ],
        };
        await deps.sendCard(mainJid, card);
      } else {
        const message = [
          `**Tool Access Request**`,
          ``,
          `**Group:** ${groupName}`,
          `**Tool:** ${toolNames[tool] || tool}`,
          `**Reason:** ${reason}`,
          participants.length > 0
            ? `**Members:** ${participants.join(', ')}`
            : `**Members:** _(no recent activity)_`,
          ``,
          `To approve, re-register the group with the flag enabled:`,
          '```',
          `register_group with jid="${requestChatJid}" and containerConfig: { ${configFlag} }`,
          '```',
        ].join('\n');
        await deps.sendMessage(mainJid, message);
      }
      logger.info(
        { tool, groupName, sourceGroup, mainJid },
        'Tool access request forwarded to main group',
      );
      break;
    }

    case 'alert_history_query': {
      const hours = typeof data.hours === 'number' ? data.hours : 24;
      const limit = typeof data.limit === 'number' ? data.limit : 20;
      const query = data.query as string | undefined;
      const fingerprint = data.fingerprint as string | undefined;

      let alerts;
      if (fingerprint) {
        alerts = getAlertsByFingerprint(fingerprint, limit);
      } else if (query) {
        alerts = searchAlertsFts(query, limit);
      } else {
        const since = new Date(Date.now() - hours * 3600000).toISOString();
        alerts = getRecentAlerts(since, limit);
      }

      const resultPath = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'alert_history_result.json',
      );
      const tempPath = `${resultPath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          alerts,
          count: alerts.length,
          queriedAt: new Date().toISOString(),
        }),
      );
      fs.renameSync(tempPath, resultPath);
      logger.info(
        { sourceGroup, count: alerts.length, fingerprint, query, hours },
        'Alert history query processed',
      );
      break;
    }

    case 'clear_session': {
      // Clear session for own group (any group) or another group (main only)
      const targetFolder = (data.targetFolder as string) || sourceGroup;
      if (targetFolder !== sourceGroup && !isMain) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Non-main group tried to clear another group session',
        );
        break;
      }
      const clearSummary = (data.summary as string) || undefined;
      deps.clearSession(targetFolder, clearSummary);
      logger.info(
        { targetFolder, sourceGroup, summary: clearSummary },
        'Session cleared via IPC — next invocation starts fresh',
      );
      break;
    }

    case 'recover_session': {
      // Restore a previous session ID for own group or another group (main only)
      const recoverFolder = (data.targetFolder as string) || sourceGroup;
      const recoverSessionId = data.sessionId as string;
      if (!recoverSessionId) {
        logger.warn({ data }, 'Invalid recover_session — missing sessionId');
        break;
      }
      if (recoverFolder !== sourceGroup && !isMain) {
        logger.warn(
          { sourceGroup, recoverFolder },
          'Non-main group tried to recover another group session',
        );
        break;
      }
      deps.setSession(recoverFolder, recoverSessionId);
      logger.info(
        { recoverFolder, recoverSessionId, sourceGroup },
        'Session recovered via IPC',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
