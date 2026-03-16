import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Claw',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Capture the adapter's process callback for testing
let lastProcessLogic: ((context: any) => Promise<void>) | null = null;

const mockContinueConversationAsync = vi.fn();
const mockAdapterProcess = vi.fn(async (_req: any, _res: any, logic: any) => {
  lastProcessLogic = logic;
});

vi.mock('botbuilder', () => {
  class MockCloudAdapter {
    onTurnError: any;
    process = mockAdapterProcess;
    continueConversationAsync = mockContinueConversationAsync;
  }
  return {
    CloudAdapter: MockCloudAdapter,
    ConfigurationBotFrameworkAuthentication: vi.fn(),
    TurnContext: {
      getConversationReference: vi.fn((activity: any) => ({
        conversation: activity.conversation,
        bot: activity.recipient,
        serviceUrl: activity.serviceUrl || 'https://smba.trafficmanager.net/',
      })),
    },
  };
});

// Mock http.createServer — capture the request handler
let capturedHandler: ((req: any, res: any) => Promise<void>) | null = null;
const mockServerInstance = {
  listen: vi.fn((_port: number, cb: Function) => cb()),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    createServer: vi.fn((handler: any) => {
      capturedHandler = handler;
      return mockServerInstance;
    }),
  };
});

import { TeamsChannel, TeamsChannelOpts } from './teams.js';

// --- Helpers ---

function createTestOpts(
  overrides?: Partial<TeamsChannelOpts>,
): TeamsChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'teams:19:test-channel@thread.tacv2': {
        name: 'Test Channel',
        folder: 'teams_test',
        trigger: '@Claw',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

function makeActivity(overrides: Record<string, any> = {}) {
  return {
    type: 'message',
    id: 'msg-1',
    text: 'Hello Claw',
    timestamp: '2024-06-15T12:00:00.000Z',
    from: { id: 'user-aad-id', name: 'Alice', aadObjectId: 'aad-123' },
    conversation: {
      id: '19:test-channel@thread.tacv2',
      conversationType: 'channel',
      name: 'General',
    },
    recipient: { id: 'bot-id', name: 'Claw' },
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    ...overrides,
  };
}

function makeTurnContext(activity: any) {
  return {
    activity,
    sendActivity: vi.fn(),
  };
}

/** Simulate a POST /api/messages hitting the HTTP handler, then invoke the bot logic. */
async function simulateIncomingMessage(
  activity: any,
): Promise<ReturnType<typeof makeTurnContext>> {
  // Simulate the HTTP request handler
  const req = {
    url: '/api/messages',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on: vi.fn((event: string, cb: Function) => {
      if (event === 'data') cb(Buffer.from(JSON.stringify(activity)));
      if (event === 'end') cb();
    }),
  };
  const res = {
    socket: null,
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };

  await capturedHandler!(req, res);

  // Now invoke the captured bot logic with a TurnContext
  const context = makeTurnContext(activity);
  if (lastProcessLogic) await lastProcessLogic(context);
  return context;
}

// --- Tests ---

describe('TeamsChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastProcessLogic = null;
    capturedHandler = null;
  });

  describe('connect', () => {
    it('starts HTTP server on the configured port', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      expect(mockServerInstance.listen).toHaveBeenCalledWith(
        3978,
        expect.any(Function),
      );
      expect(channel.isConnected()).toBe(true);
    });

    it('serves health endpoint', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const res = { writeHead: vi.fn(), end: vi.fn() };
      await capturedHandler!(
        { url: '/health', method: 'GET', headers: {} },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({ status: 'ok', connected: true }),
      );
    });

    it('returns 404 for unknown routes', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const res = { writeHead: vi.fn(), end: vi.fn() };
      await capturedHandler!(
        { url: '/unknown', method: 'GET', headers: {} },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(404);
    });
  });

  describe('message handling', () => {
    it('delivers message for registered conversation', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity();
      await simulateIncomingMessage(activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:19:test-channel@thread.tacv2',
        '2024-06-15T12:00:00.000Z',
        'General',
        'teams',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:test-channel@thread.tacv2',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello Claw',
          sender: 'aad-123',
          sender_name: 'Alice',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('auto-registers unregistered personal conversations without trigger', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        conversation: {
          id: 'unregistered-conv',
          conversationType: 'personal',
        },
      });
      await simulateIncomingMessage(activity);

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'teams:unregistered-conv',
        expect.objectContaining({
          requiresTrigger: false,
        }),
      );
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('auto-registers group conversations with trigger required', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        conversation: {
          id: 'group-conv',
          conversationType: 'groupChat',
          name: 'Project Team',
        },
      });
      await simulateIncomingMessage(activity);

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'teams:group-conv',
        expect.objectContaining({
          requiresTrigger: true,
          name: 'Project Team',
        }),
      );
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('does not re-register already registered conversations', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      await simulateIncomingMessage(makeActivity());

      expect(opts.registerGroup).not.toHaveBeenCalled();
    });

    it('strips <at> mention tags from text', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        text: '<at>Claw</at> what is the weather?',
      });
      await simulateIncomingMessage(activity);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:19:test-channel@thread.tacv2',
        expect.objectContaining({ content: 'what is the weather?' }),
      );
    });

    it('ignores messages with only mention tags (no real text)', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({ text: '<at>Claw</at>  ' });
      await simulateIncomingMessage(activity);

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-message activities', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        type: 'conversationUpdate',
        text: null,
      });
      await simulateIncomingMessage(activity);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('identifies group chats correctly', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'teams:group-chat-id': {
            name: 'Group Chat',
            folder: 'teams_gc',
            trigger: '@Claw',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        conversation: {
          id: 'group-chat-id',
          conversationType: 'groupChat',
          name: 'Project Team',
        },
      });
      await simulateIncomingMessage(activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:group-chat-id',
        expect.any(String),
        'Project Team',
        'teams',
        true,
      );
    });

    it('identifies DMs correctly', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const activity = makeActivity({
        conversation: {
          id: 'dm-conv-id',
          conversationType: 'personal',
        },
      });
      await simulateIncomingMessage(activity);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:dm-conv-id',
        expect.any(String),
        undefined,
        'teams',
        false,
      );
    });
  });

  describe('sendMessage', () => {
    it('sends via continueConversationAsync with stored reference', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      // Receive a message first to store the conversation reference
      await simulateIncomingMessage(makeActivity());

      mockContinueConversationAsync.mockImplementation(
        async (_appId: any, _ref: any, logic: any) => {
          const sendCtx = { sendActivity: vi.fn() };
          await logic(sendCtx);
        },
      );

      await channel.sendMessage('teams:19:test-channel@thread.tacv2', 'Hello!');

      expect(mockContinueConversationAsync).toHaveBeenCalledWith(
        'app-id',
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: '19:test-channel@thread.tacv2',
          }),
        }),
        expect.any(Function),
      );
    });

    it('warns when no conversation reference exists', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();

      const { logger } = await import('../logger.js');

      await channel.sendMessage('teams:unknown-conv', 'Hello!');

      expect(mockContinueConversationAsync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { jid: 'teams:unknown-conv' },
        expect.stringContaining('No conversation reference'),
      );
    });
  });

  describe('ownsJid', () => {
    it('owns teams: prefixed JIDs', () => {
      const channel = new TeamsChannel(createTestOpts(), 'a', 'b', 3978);
      expect(channel.ownsJid('teams:19:abc@thread.tacv2')).toBe(true);
      expect(channel.ownsJid('teams:direct-message-id')).toBe(true);
    });

    it('does not own non-teams JIDs', () => {
      const channel = new TeamsChannel(createTestOpts(), 'a', 'b', 3978);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('closes the HTTP server', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts, 'app-id', 'app-pass', 3978);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockServerInstance.close).toHaveBeenCalled();
    });
  });

  describe('setTyping', () => {
    it('is a no-op (Teams has no typing API)', async () => {
      const channel = new TeamsChannel(createTestOpts(), 'a', 'b', 3978);
      await channel.connect();
      await expect(
        channel.setTyping('teams:conv', true),
      ).resolves.toBeUndefined();
    });
  });

  describe('channel properties', () => {
    it('has name "teams"', () => {
      const channel = new TeamsChannel(createTestOpts(), 'a', 'b', 3978);
      expect(channel.name).toBe('teams');
    });
  });
});
