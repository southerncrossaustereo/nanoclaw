import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  Activity,
  ConversationReference,
} from 'botbuilder';
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts, OnRegisterGroup } from './registry.js';

const TEAMS_MESSAGE_SIZE_LIMIT = 16_000; // ~16KB, leave room for overhead

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: OnRegisterGroup;
}

/**
 * Build the NanoClaw JID for a Teams conversation.
 *
 * Format:
 *  - Team channel: teams:{channelId}
 *  - Group chat / DM: teams:{conversationId}
 *
 * The conversation ID from Teams can contain special characters
 * (colons, semicolons, etc.) so we use it as-is after the "teams:" prefix.
 */
function conversationToJid(activity: Partial<Activity>): string {
  const convId = activity.conversation?.id;
  if (!convId) throw new Error('Activity has no conversation ID');
  return `teams:${convId}`;
}

/**
 * Strip Teams `<at>` mention tags and normalise whitespace.
 * Teams wraps mentions as: <at>BotName</at>
 */
function stripMentions(text: string): string {
  return text
    .replace(/<at>.*?<\/at>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check whether the bot was @mentioned in the activity.
 * Teams includes a `mentions` array on the activity's `entities` field
 * with an entry whose `mentioned.id` matches the bot's app ID.
 * The mention ID may include a channel prefix (e.g. "28:<appId>"),
 * so we check whether the ID contains the app ID.
 */
function isBotMentioned(activity: Partial<Activity>, botId: string): boolean {
  if (!activity.entities) return false;
  return activity.entities.some(
    (e) => e.type === 'mention' && (e as any).mentioned?.id?.includes(botId),
  );
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private adapter!: CloudAdapter;
  private connected = false;
  private port: number;
  private appId: string;
  private appPassword: string;
  private server: Server | null = null;

  // Store conversation references keyed by JID for proactive messaging
  private conversationRefs = new Map<string, Partial<ConversationReference>>();

  private opts: TeamsChannelOpts;

  private tenantId: string | undefined;

  constructor(
    opts: TeamsChannelOpts,
    appId: string,
    appPassword: string,
    port: number,
    tenantId?: string,
  ) {
    this.opts = opts;
    this.appId = appId;
    this.appPassword = appPassword;
    this.port = port;
    this.tenantId = tenantId;
  }

  async connect(): Promise<void> {
    const isSingleTenant = !!this.tenantId;
    const botAuth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.appId,
      MicrosoftAppPassword: this.appPassword,
      MicrosoftAppType: isSingleTenant ? 'SingleTenant' : 'MultiTenant',
      ...(isSingleTenant && { MicrosoftAppTenantId: this.tenantId }),
      // Explicitly set to public Azure (not government) to avoid validation
      // against the wrong OpenID metadata endpoint
      ChannelService: '',
    });

    this.adapter = new CloudAdapter(botAuth);

    // Error handler
    this.adapter.onTurnError = async (context, error) => {
      logger.error({ err: error }, 'Teams adapter turn error');
      try {
        await context.sendActivity('Sorry, something went wrong.');
      } catch {
        // Swallow — the conversation may be gone
      }
    };

    this.server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url || '';
        const method = req.method || '';

        logger.info({ method, url }, 'Teams HTTP request received');

        // CORS preflight — Teams sends OPTIONS before POST
        if (method === 'OPTIONS') {
          res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end();
          return;
        }

        // Health endpoint
        if (method === 'GET' && url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', connected: this.connected }));
          return;
        }

        // Teams messaging endpoint
        if (method === 'POST' && url === '/api/messages') {
          try {
            // Read body and wrap req/res for the Bot Framework adapter
            const body = await readBody(req);
            logger.info(
              {
                type: body.type,
                from: body.from,
                hasAuth: !!req.headers.authorization,
              },
              'Teams activity received',
            );
            const botReq = toBotRequest(req, body);
            const botRes = toBotResponse(res);
            await this.adapter.process(botReq, botRes, (context) =>
              this.handleActivity(context),
            );
          } catch (err: any) {
            logger.error(
              {
                err: err?.message || err,
                statusCode: err?.statusCode,
                stack: err?.stack,
              },
              'Teams /api/messages processing error',
            );
            if (!res.writableEnded) {
              res.writeHead(err?.statusCode || 500);
              res.end(err?.message || 'Internal Server Error');
            }
          }
          return;
        }

        res.writeHead(404);
        res.end();
      },
    );

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, () => {
        this.connected = true;
        logger.info(
          { port: this.port, tenantMode: isSingleTenant ? 'single' : 'multi' },
          'Teams channel connected — listening for webhook',
        );
        resolve();
      });
      this.server!.on('error', (err: Error) => {
        logger.error({ err }, 'Teams HTTP server error');
        reject(err);
      });
    });
  }

  private async handleActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Store conversation reference for proactive messaging
    const ref = TurnContext.getConversationReference(activity);
    const jid = conversationToJid(activity);
    this.conversationRefs.set(jid, ref);

    if (activity.type === 'message' && activity.text) {
      const botMentioned = isBotMentioned(activity, this.appId);
      let text = stripMentions(activity.text);

      // If the bot was @mentioned in Teams (e.g. @NanoClaw-DEV), prepend
      // the canonical trigger so the router's TRIGGER_PATTERN matches.
      // This also handles the case where the message is *only* a mention
      // (stripped text is empty).
      if (botMentioned) {
        text = text ? `@${ASSISTANT_NAME} ${text}` : `@${ASSISTANT_NAME}`;
      }

      if (!text) return;

      const timestamp = activity.timestamp
        ? new Date(activity.timestamp).toISOString()
        : new Date().toISOString();

      const sender = activity.from?.aadObjectId || activity.from?.id || '';
      const senderName = activity.from?.name || sender;

      const isGroup =
        activity.conversation?.conversationType === 'channel' ||
        activity.conversation?.conversationType === 'groupChat';

      // Always emit metadata for chat discovery
      this.opts.onChatMetadata(
        jid,
        timestamp,
        activity.conversation?.name,
        'teams',
        isGroup,
      );

      // Auto-register Teams conversations on first message
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        const convName =
          activity.conversation?.name || senderName || 'Teams Chat';
        const folder = this.generateFolderName(jid, convName);

        // Personal (1:1) chats: respond to everything
        // Group chats / channels: only respond to @mentions
        const requiresTrigger = isGroup;

        this.opts.registerGroup(jid, {
          name: convName,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger,
        });

        logger.info(
          { jid, name: convName, folder, requiresTrigger },
          'Teams conversation auto-registered',
        );
      }

      this.opts.onMessage(jid, {
        id: activity.id || '',
        chat_jid: jid,
        sender,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    }
  }

  /**
   * Generate a safe folder name for a Teams conversation.
   * Must match: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
   */
  private generateFolderName(jid: string, name: string): string {
    // Try to make a human-readable folder from the conversation name
    const sanitized = name
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50);

    const base = sanitized || 'teams';
    const prefix = `teams-${base}`;

    // Ensure uniqueness by checking existing registrations
    const groups = this.opts.registeredGroups();
    const usedFolders = new Set(Object.values(groups).map((g) => g.folder));

    if (!usedFolders.has(prefix)) return prefix;

    // Append a short hash from the JID for uniqueness
    let hash = 0;
    for (const ch of jid) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const suffix = Math.abs(hash).toString(36).slice(0, 6);
    return `${prefix}-${suffix}`;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ref = this.conversationRefs.get(jid);
    if (!ref) {
      logger.warn(
        { jid },
        'No conversation reference for JID — bot has not received a message from this conversation yet',
      );
      return;
    }

    // Split long messages at the Teams limit
    const chunks = splitMessage(text, TEAMS_MESSAGE_SIZE_LIMIT);

    for (const chunk of chunks) {
      await this.adapter.continueConversationAsync(
        this.appId,
        ref as ConversationReference,
        async (context) => {
          await context.sendActivity(chunk);
        },
      );
    }

    logger.info(
      { jid, length: text.length, chunks: chunks.length },
      'Teams message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Teams typing auto-expires; no explicit "stop" needed

    const ref = this.conversationRefs.get(jid);
    if (!ref) return;

    try {
      await this.adapter.continueConversationAsync(
        this.appId,
        ref as ConversationReference,
        async (context) => {
          await context.sendActivity({ type: 'typing' });
        },
      );
    } catch (err) {
      logger.debug({ jid, error: err }, 'Failed to send typing indicator');
    }
  }
}

/** Read the full request body as a parsed JSON object. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Wrap Node IncomingMessage into the shape Bot Framework expects. */
function toBotRequest(req: IncomingMessage, body: Record<string, unknown>) {
  return {
    body,
    headers: req.headers as Record<string, string | string[] | undefined>,
    method: req.method,
  };
}

/** Wrap Node ServerResponse into the shape Bot Framework expects. */
function toBotResponse(res: ServerResponse) {
  let statusCode = 200;
  return {
    socket: res.socket,
    status(code: number) {
      statusCode = code;
      return this;
    },
    header(name: string, value: unknown) {
      res.setHeader(name, String(value));
      return this;
    },
    send(bodyArg?: unknown) {
      const content =
        typeof bodyArg === 'string' ? bodyArg : JSON.stringify(bodyArg ?? '');
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(content);
      return this;
    },
    end(...args: unknown[]) {
      res.end(...(args as []));
      return this;
    },
  };
}

/**
 * Split a message into chunks that fit within the Teams size limit.
 * Tries to split on newline boundaries; falls back to hard split.
 */
function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to find a newline to split on
    let splitIdx = remaining.lastIndexOf('\n', limit);
    if (splitIdx <= 0) {
      // No good newline — try space
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx <= 0) {
      // Hard split
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

// --- Self-registration ---

registerChannel('teams', (opts: ChannelOpts) => {
  const env = readEnvFile([
    'TEAMS_APP_ID',
    'TEAMS_APP_PASSWORD',
    'TEAMS_PORT',
    'TEAMS_TENANT_ID',
  ]);
  const appId = process.env.TEAMS_APP_ID || env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD || env.TEAMS_APP_PASSWORD;

  if (!appId || !appPassword) {
    return null; // Credentials missing — skip this channel
  }

  const port = parseInt(process.env.TEAMS_PORT || env.TEAMS_PORT || '3978', 10);
  const tenantId = process.env.TEAMS_TENANT_ID || env.TEAMS_TENANT_ID;

  return new TeamsChannel(opts, appId, appPassword, port, tenantId);
});
