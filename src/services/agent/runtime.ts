import { sessions } from '@services/database/sqlite.ts';
import { cancelApprovalsForSession, requestApproval } from '@services/discord/approvals.ts';
import { StreamRenderer } from '@services/discord/render.ts';
import { memoryContext, writeDigest } from '@services/memory/inject.ts';
import { reflectTurn, worthReflecting } from '@services/memory/reflect.ts';
import { tierOf } from '@services/policy/gate.ts';
import { log } from '@utils/logger.ts';

import { isDelta, isIdle, isPermissionAsked, isRetry, isToolPart, type AgentEvent } from './events.ts';
import { models } from './models.ts';

import type { Supervisor } from './supervisor.ts';
import type { Client, GuildMember, TextChannel } from 'discord.js';

const logger = log('runtime');
const IDLE_TIMEOUT_MS = 15 * 60_000;

type Stream = {
  renderer: StreamRenderer;
  resolve: () => void;
  toolCalls: Array<{ tool: string; status?: string; input?: unknown }>;
};

export type AskInput = {
  guildId: string;
  guildName: string;
  channel: TextChannel;
  actorId: string;
  actorName: string;
  member: GuildMember | null;
  text: string;
};

/**
 * Owns the chat→session→stream lifecycle. One prompt per chat at a time (queued), one live message per
 * prompt, and permission asks from the server are turned into Discord approval cards whose decision is fed
 * straight back to `/permission/{id}/reply`.
 */
export class Runtime {
  private readonly streams = new Map<string, Stream>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly client: Client,
    private readonly supervisor: Supervisor,
  ) {}

  async ask(input: AskInput): Promise<void> {
    const chatKey = `${input.guildId}:${input.channel.id}`;
    const previous = this.queues.get(chatKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(input, chatKey));
    this.queues.set(chatKey, next);
    try {
      await next;
    } finally {
      if (this.queues.get(chatKey) === next) this.queues.delete(chatKey);
    }
  }

  private async run(input: AskInput, chatKey: string): Promise<void> {
    const server = await this.supervisor.ensure(input.guildId, input.guildName);
    let sessionId = sessions.get(chatKey)?.session_id;
    if (!sessionId) sessionId = await server.opencode.createSession(`${input.guildName} / #${input.channel.name}`);

    sessions.set({
      'chat_key': chatKey,
      'guild_id': input.guildId,
      'channel_id': input.channel.id,
      'session_id': sessionId,
      'actor_id': input.actorId,
    });

    const renderer = new StreamRenderer(input.channel, '🧠 thinking…');
    await renderer.start();

    const idle = Promise.withResolvers<void>();
    this.streams.set(sessionId, { renderer, 'resolve': idle.resolve, 'toolCalls': [] });

    const rank = ['guest', 'member', 'trusted', 'admin', 'owner'][tierOf(input.guildId, input.member)];
    const prompt =
      `[#${input.channel.name} · ${input.actorName} · rank ${rank}]\n${input.text}` +
      memoryContext(input.guildId, input.text);

    try {
      await server.opencode.prompt(sessionId, prompt, models.primary());
      const timeout = setTimeout(() => {
        logger.warn('prompt timed out', { chatKey, sessionId });
        idle.resolve();
      }, IDLE_TIMEOUT_MS);
      await idle.promise;
      clearTimeout(timeout);

      const finalText = await server.opencode.lastText(sessionId);
      await renderer.finish(finalText);
      sessions.touch(chatKey);

      const toolCalls = this.streams.get(sessionId)?.toolCalls ?? [];
      if (worthReflecting({ 'userText': input.text, 'assistantText': finalText, toolCalls }))
        void (async () => {
          const written = await reflectTurn(server, {
            'guildId': input.guildId,
            sessionId,
            'userText': input.text,
            'assistantText': finalText,
            toolCalls,
          });
          if (written > 0) writeDigest(input.guildId);
        })();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('prompt failed', { chatKey, 'error': message.slice(0, 300) });
      await renderer.fail(message);
    } finally {
      this.streams.delete(sessionId);
      cancelApprovalsForSession(sessionId);
    }
  }

  handleEvent(guildId: string, event: AgentEvent): void {
    const sessionId = typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : undefined;
    const stream = sessionId ? this.streams.get(sessionId) : undefined;

    if (stream && isDelta(event) && event.properties.field === 'text') {
      stream.renderer.push(event.properties.delta);
      return;
    }
    if (stream && isToolPart(event)) {
      const part = event.properties.part;
      stream.toolCalls.push({ 'tool': part.tool ?? 'tool', 'status': part.state?.status, 'input': part.state?.input });
      stream.renderer.setStatus(`🔧 ${part.tool ?? 'tool'} · ${part.state?.status ?? 'running'}`);
      return;
    }
    if (stream && isRetry(event)) {
      stream.renderer.setStatus(`retrying: ${String(event.properties.status.message ?? '').slice(0, 120)}`);
      return;
    }
    if (sessionId && isIdle(event)) {
      stream?.resolve();
      return;
    }
    if (isPermissionAsked(event)) void this.handlePermissionAsk(guildId, event);
  }

  private async handlePermissionAsk(
    guildId: string,
    event: Extract<AgentEvent, { type: 'permission.asked' }>,
  ): Promise<void> {
    const server = this.supervisor.get(guildId);
    const session = sessions.byOpenCodeId(event.properties.sessionID);
    if (!server || !session) {
      logger.warn('permission ask without server/session; rejecting', { guildId, 'requestID': event.properties.id });
      await server?.opencode.replyPermission(event.properties.id, 'reject');
      return;
    }
    const patterns = event.properties.patterns.join(', ');
    const always = event.properties.always?.join(', ');
    const outcome = await requestApproval({
      'client': this.client,
      guildId,
      'chatKey': session.chat_key,
      'channelId': session.channel_id,
      'actorId': session.actor_id ?? 'unknown',
      'kind': 'permission',
      'title': `${event.properties.permission}: ${patterns || '(no pattern)'}`.slice(0, 200),
      'detail': [
        `The agent wants to run a **${event.properties.permission}** action.`,
        patterns ? `target: \`${patterns}\`` : '',
        always ? `"Always" would save: \`${always}\`` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      'sessionId': event.properties.sessionID,
      'requestId': event.properties.id,
    });
    const reply = outcome === 'allowed' ? 'once' : outcome === 'always' ? 'always' : 'reject';
    const ok = await server.opencode.replyPermission(event.properties.id, reply);
    logger.info('permission answered', { 'requestID': event.properties.id, outcome, 'delivered': ok });
  }

  async abort(chatKey: string): Promise<boolean> {
    const session = sessions.get(chatKey);
    if (!session) return false;
    const server = this.supervisor.get(session.guild_id);
    if (!server) return false;
    await server.opencode.abort(session.session_id);
    return true;
  }

  async reset(
    chatKey: string,
    guildId: string,
    guildName: string,
    channelId: string,
    actorId: string,
  ): Promise<string> {
    const server = await this.supervisor.ensure(guildId, guildName);
    const sessionId = await server.opencode.createSession(`${guildName} / #${channelId} (${new Date().toISOString()})`);
    sessions.set({
      'chat_key': chatKey,
      'guild_id': guildId,
      'channel_id': channelId,
      'session_id': sessionId,
      'actor_id': actorId,
    });
    return sessionId;
  }

  activeStreams(): number {
    return this.streams.size;
  }
}
