/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';

import {
  ATLASSIAN_TOKENS_PATH,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GITHUB_APP_CONFIG_PATH,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_WORKSPACE_SIZE,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  initSecretProvider,
  resolveSecrets,
  SecretProvider,
} from './secret-provider.js';
import { readEnvFile } from './env.js';
import { getRecentAlerts, getPendingAlerts } from './alert-db.js';
import { containerInvocationsTotal, containerDuration } from './metrics.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

let secretProvider: SecretProvider | null = null;

/** Initialize the secret provider. Call once from main() before any container runs. */
export async function initSecrets(): Promise<void> {
  secretProvider = await initSecretProvider();
  if (secretProvider) {
    logger.info(
      { provider: secretProvider.name },
      'Secret provider initialized',
    );
  }
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  scheduledTasksAccess?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface QuotaInfo {
  groupName: string;
  chatJid: string;
  sizeMB: string;
  limitMB: string;
}

/** Called when workspace quota is exceeded - should notify main chat and user chat */
export type QuotaExceededCallback = (info: QuotaInfo) => Promise<void>;

/** Called when workspace is approaching quota - should notify user chat only */
export type QuotaWarningCallback = (info: QuotaInfo) => Promise<void>;

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Conversation archives: mount read-only so agents can read but not delete.
  // New archives are written via IPC and moved here by the host.
  const conversationsDir = path.join(groupDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  mounts.push({
    hostPath: conversationsDir,
    containerPath: '/workspace/group/conversations',
    readonly: true,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'conversations'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Azure CLI: no longer mounts host ~/.azure/ — service principal auth
  // is injected via env vars and `az login` runs in the entrypoint.

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Generic token file loader with per-group keys and _default fallback.
 * Caches each file in memory for the lifetime of the process.
 * Resolves any `vault:secret-name` references via the secret provider.
 */
const tokenFileCache = new Map<string, Record<string, unknown>>();

async function loadTokenFile<T>(
  filePath: string,
  groupFolder: string,
): Promise<T | null> {
  if (!tokenFileCache.has(filePath)) {
    try {
      if (fs.existsSync(filePath)) {
        let parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (secretProvider) {
          parsed = await resolveSecrets(parsed, secretProvider);
        }
        tokenFileCache.set(filePath, parsed);
      } else {
        tokenFileCache.set(filePath, {});
      }
    } catch (err) {
      logger.warn({ path: filePath, error: err }, 'Failed to load token file');
      tokenFileCache.set(filePath, {});
    }
  }

  const data = tokenFileCache.get(filePath)!;
  return ((data[groupFolder] ?? data['_default']) as T) || null;
}

/**
 * GitHub App configuration file format:
 * {
 *   "appId": 123456,
 *   "privateKeyPath": "/home/user/.config/nanoclaw/github-app.pem",
 *   "installationId": 78901234
 * }
 */
interface GitHubAppConfig {
  appId: number;
  privateKeyPath: string;
  installationId: number;
}

/** Cache for GitHub App installation tokens (they last 1 hour, we refresh at 50 min) */
let appTokenCache: { token: string; expiresAt: number } | null = null;

/** Create an RS256 JWT for GitHub App authentication */
function createGitHubAppJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(appId) }),
  ).toString('base64url');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

/** Exchange a JWT for a short-lived installation access token via GitHub API */
function requestInstallationToken(
  jwt: string,
  installationId: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/app/installations/${installationId}/access_tokens`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nanoclaw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode === 201) {
            try {
              resolve(JSON.parse(body).token);
            } catch {
              reject(
                new Error(`Failed to parse GitHub token response: ${body}`),
              );
            }
          } else {
            reject(
              new Error(
                `GitHub installation token request failed (${res.statusCode}): ${body}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Load GitHub App config and generate a fresh installation token */
async function loadGithubAppToken(
  forceRefresh = false,
): Promise<string | null> {
  // Return cached token if still fresh (50 min lifetime, tokens last 1 hour)
  if (!forceRefresh && appTokenCache && Date.now() < appTokenCache.expiresAt) {
    return appTokenCache.token;
  }

  try {
    if (!fs.existsSync(GITHUB_APP_CONFIG_PATH)) return null;
    const config: GitHubAppConfig = JSON.parse(
      fs.readFileSync(GITHUB_APP_CONFIG_PATH, 'utf-8'),
    );
    if (!config.appId || !config.privateKeyPath || !config.installationId) {
      return null;
    }
    const privateKey = fs.readFileSync(config.privateKeyPath, 'utf-8');
    const jwt = createGitHubAppJwt(config.appId, privateKey);
    const token = await requestInstallationToken(jwt, config.installationId);

    appTokenCache = {
      token,
      expiresAt: Date.now() + 50 * 60 * 1000, // refresh after 50 min
    };
    logger.info('Generated fresh GitHub App installation token');
    return token;
  } catch (err) {
    logger.warn({ error: err }, 'Failed to generate GitHub App token');
    return null;
  }
}

/** Generate a fresh GitHub App installation token (exported for IPC refresh handler) */
export { loadGithubAppToken };

/** GitHub: returns a GitHub App installation token */
async function loadGithubToken(_groupFolder: string): Promise<string | null> {
  return loadGithubAppToken();
}

/**
 * Atlassian credentials file format:
 * { "_default": { "site": "mysite.atlassian.net", "email": "user@example.com", "token": "..." } }
 * or per-group: { "dev-team": { ... }, "_default": { ... } }
 */
export interface AtlassianCredentials {
  site: string;
  email: string;
  token: string;
  cloudId?: string;
}

async function loadAtlassianCredentials(
  groupFolder: string,
): Promise<AtlassianCredentials | null> {
  return loadTokenFile<AtlassianCredentials>(
    ATLASSIAN_TOKENS_PATH,
    groupFolder,
  );
}

export interface AzureSpCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Load Azure service principal credentials from environment/.env.
 * These are the same creds used by the host for Key Vault access.
 */
function loadAzureSpCredentials(): AzureSpCredentials | null {
  const envVars = readEnvFile([
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ]);
  const tenantId = process.env.AZURE_TENANT_ID || envVars.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID || envVars.AZURE_CLIENT_ID;
  const clientSecret =
    process.env.AZURE_CLIENT_SECRET || envVars.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

interface ToolCredentials {
  githubToken?: string | null;
  atlassianCreds?: AtlassianCredentials | null;
  azureCreds?: AzureSpCredentials | null;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  creds?: ToolCredentials,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Inject tool credentials as env vars for this group
  if (creds?.githubToken) {
    args.push('-e', `GH_TOKEN=${creds.githubToken}`);
  }
  if (creds?.atlassianCreds) {
    // Legacy ACLI_ vars for backward compatibility with classic API tokens
    args.push('-e', `ACLI_SITE=${creds.atlassianCreds.site}`);
    args.push('-e', `ACLI_EMAIL=${creds.atlassianCreds.email}`);
    args.push('-e', `ACLI_TOKEN=${creds.atlassianCreds.token}`);
    // Bearer-based vars for service account tokens (ATSTT prefix) and the atlassian-api wrapper
    args.push('-e', `ATLASSIAN_SITE=${creds.atlassianCreds.site}`);
    args.push('-e', `ATLASSIAN_BEARER_TOKEN=${creds.atlassianCreds.token}`);
    if (creds.atlassianCreds.cloudId) {
      args.push('-e', `ATLASSIAN_CLOUD_ID=${creds.atlassianCreds.cloudId}`);
    }
  }
  if (creds?.azureCreds) {
    args.push('-e', `AZURE_TENANT_ID=${creds.azureCreds.tenantId}`);
    args.push('-e', `AZURE_CLIENT_ID=${creds.azureCreds.clientId}`);
    args.push('-e', `AZURE_CLIENT_SECRET=${creds.azureCreds.clientSecret}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Limit /tmp to prevent tmpfs abuse (100MB limit)
  args.push('--tmpfs', '/tmp:rw,size=100m,exec');

  args.push(CONTAINER_IMAGE);

  return args;
}

function getDirectorySize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {
          /* race condition or permission error */
        }
      }
    }
  } catch {
    /* directory may not exist yet */
  }
  return total;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onQuotaWarning?: QuotaWarningCallback,
  onQuotaExceeded?: QuotaExceededCallback,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Workspace size check
  const maxSize = group.containerConfig?.maxWorkspaceSize || MAX_WORKSPACE_SIZE;
  const initialSize = maxSize > 0 ? getDirectorySize(groupDir) : 0;

  if (maxSize > 0) {
    const sizeMB = (initialSize / 1024 / 1024).toFixed(1);
    const limitMB = (maxSize / 1024 / 1024).toFixed(1);
    if (initialSize > maxSize) {
      logger.error(
        { group: group.name, sizeMB, limitMB },
        'Workspace exceeds size limit',
      );
      // Notify both main and user about quota violation (fire-and-forget)
      if (onQuotaExceeded) {
        onQuotaExceeded({
          groupName: group.name,
          chatJid: input.chatJid,
          sizeMB,
          limitMB,
        }).catch((err) => {
          logger.warn(
            { err, group: group.name },
            'Failed to send quota exceeded notification',
          );
        });
      }
      return {
        status: 'error',
        result: null,
        error: `Workspace is ${sizeMB}MB, exceeding the ${limitMB}MB limit. Clean up files to continue.`,
      };
    }
    if (initialSize > maxSize * 0.8) {
      logger.warn(
        { group: group.name, sizeMB, limitMB },
        'Workspace approaching size limit',
      );
      // Notify user chat about approaching limit (fire-and-forget)
      if (onQuotaWarning) {
        onQuotaWarning({
          groupName: group.name,
          chatJid: input.chatJid,
          sizeMB,
          limitMB,
        }).catch((err) => {
          logger.warn(
            { err, group: group.name },
            'Failed to send quota warning notification',
          );
        });
      }
    }
  }

  // Helper to check workspace size after container completes and notify if exceeded
  const checkPostExecutionSize = () => {
    if (maxSize <= 0 || !onQuotaExceeded) return;
    const finalSize = getDirectorySize(groupDir);
    if (finalSize > maxSize && finalSize > initialSize) {
      const sizeMB = (finalSize / 1024 / 1024).toFixed(1);
      const limitMB = (maxSize / 1024 / 1024).toFixed(1);
      logger.warn(
        { group: group.name, sizeMB, limitMB },
        'Workspace exceeded size limit during execution',
      );
      onQuotaExceeded({
        groupName: group.name,
        chatJid: input.chatJid,
        sizeMB,
        limitMB,
      }).catch((err) => {
        logger.warn(
          { err, group: group.name },
          'Failed to send post-execution quota notification',
        );
      });
    }
  };

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const creds: ToolCredentials = {
    githubToken: group.containerConfig?.githubAccess
      ? await loadGithubToken(group.folder)
      : null,
    atlassianCreds: group.containerConfig?.atlassianAccess
      ? await loadAtlassianCredentials(group.folder)
      : null,
    azureCreds: group.containerConfig?.azureAccess
      ? loadAzureSpCredentials()
      : null,
  };
  const containerArgs = buildContainerArgs(mounts, containerName, creds);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    containerInvocationsTotal?.add(1, { group: group.name });

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      containerDuration?.record(duration / 1000, {
        group: group.name,
        status: timedOut ? 'timeout' : code !== 0 ? 'error' : 'success',
      });

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          checkPostExecutionSize();
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        checkPostExecutionSize();
        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

/**
 * Write session history snapshot for the container to read.
 * Main group can see all groups' histories; non-main only sees its own.
 */
export function writeSessionHistorySnapshot(
  groupFolder: string,
  isMain: boolean,
  history: Array<{
    id: number;
    group_folder: string;
    session_id: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    summary: string | null;
    message_count: number;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filtered = isMain
    ? history
    : history.filter((h) => h.group_folder === groupFolder);

  const historyFile = path.join(groupIpcDir, 'session_history.json');
  fs.writeFileSync(historyFile, JSON.stringify(filtered, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * Write alert subscriptions snapshot for the container to read.
 * Main sees all subscriptions; others see only their own.
 */
export function writeSubscriptionsSnapshot(
  groupFolder: string,
  isMain: boolean,
  subscriptions: Array<{
    id: string;
    groupJid: string;
    groupFolder: string;
    patterns: unknown[];
    isProtected: boolean;
    minSeverity?: number;
    createdAt: string;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filtered = isMain
    ? subscriptions
    : subscriptions.filter((s) => s.groupFolder === groupFolder);

  const subsFile = path.join(groupIpcDir, 'alert_subscriptions.json');
  fs.writeFileSync(subsFile, JSON.stringify(filtered, null, 2));
}

/**
 * Write a snapshot of recent alert status to the group's IPC directory
 * so container agents can read it from /workspace/ipc/alerts-status.json.
 */
export function writeAlertsSnapshot(groupFolder: string): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = getRecentAlerts(since1h, 100);
  const pending = getPendingAlerts();

  const byStatus: Record<string, number> = {};
  for (const a of recent) {
    const s = a.investigationStatus || 'unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    lastHour: {
      total: recent.length,
      byInvestigationStatus: byStatus,
      alerts: recent.map(
        (a: {
          id: string;
          type: string;
          severity: number;
          status: string;
          investigationStatus?: string;
          investigationSummary?: string;
          firedAt: string;
          resource: string;
        }) => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          status: a.status,
          investigationStatus: a.investigationStatus,
          investigationSummary: a.investigationSummary,
          firedAt: a.firedAt,
          resource: a.resource,
        }),
      ),
    },
    pendingInvestigations: {
      count: pending.length,
      alerts: pending.map(
        (a: {
          id: string;
          type: string;
          severity: number;
          firedAt: string;
        }) => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          firedAt: a.firedAt,
        }),
      ),
    },
  };

  fs.writeFileSync(
    path.join(groupIpcDir, 'alerts-status.json'),
    JSON.stringify(snapshot, null, 2),
  );
}

/**
 * Assemble tool documentation based on the group's containerConfig flags.
 * Reads snippet files from container/tool-docs/ and writes a combined
 * tool-docs.md into the group's IPC directory for the agent-runner to inject.
 */
const TOOL_DOCS_DIR = path.join(process.cwd(), 'container', 'tool-docs');
const TOOL_DOC_FILES: Record<string, string> = {
  githubAccess: 'github.md',
  azureAccess: 'azure.md',
  atlassianAccess: 'atlassian.md',
  scheduledTasksAccess: 'scheduled-tasks.md',
};

export function writeToolDocsSnapshot(
  groupFolder: string,
  containerConfig?: ContainerConfig,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const sections: string[] = [];
  for (const [flag, filename] of Object.entries(TOOL_DOC_FILES)) {
    if (containerConfig?.[flag as keyof ContainerConfig]) {
      const docPath = path.join(TOOL_DOCS_DIR, filename);
      if (fs.existsSync(docPath)) {
        sections.push(fs.readFileSync(docPath, 'utf-8').trim());
      }
    }
  }

  const toolDocsFile = path.join(groupIpcDir, 'tool-docs.md');
  if (sections.length > 0) {
    fs.writeFileSync(
      toolDocsFile,
      '# Available Tools\n\n' + sections.join('\n\n---\n\n') + '\n',
    );
  } else {
    try {
      fs.unlinkSync(toolDocsFile);
    } catch {
      /* no file to remove */
    }
  }
}
