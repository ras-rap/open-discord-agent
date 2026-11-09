import { sessions } from '@services/database/sqlite.ts';
import { cancelApprovalsForSession, requestApproval } from '@services/discord/approvals.ts';
import {
  cancelQuestion,
  pendingForSession as pendingQuestionsForSession,
  requestAnswers,
} from '@services/discord/questions.ts';
import { StreamRenderer } from '@services/discord/render.ts';
import { commitWorkspace } from '@services/evolution/skills.ts';
import { memoryContext, writeDigest } from '@services/memory/inject.ts';
import { reflectTurn, worthReflecting } from '@services/memory/reflect.ts';
import { screenPermission, tierOf } from '@services/policy/gate.ts';
import { optionalEnv } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

import { diagnosisCode, failureText } from './errors.ts';
import {
  isDelta,
  isIdle,
  isPermissionAsked,
  isQuestionAsked,
  isReasoningPart,
  isRetry,
  isToolPart,
  type AgentEvent,
  type QuestionAsked,
} from './events.ts';
import { models } from './models.ts';

import type { Supervisor } from './supervisor.ts';
import type { Client, GuildMember, TextChannel } from 'discord.js';

const logger = log('runtime');
/**
 * Silence, not wall-clock: a long task that keeps streaming deltas or tool parts is never killed, while a
 * server that has gone quiet is. A fixed whole-turn deadline used to abandon work that was still progressing.
 * Overridable because a slow local runtime may legitimately need a longer window.
 */
const configuredSilence = Number(optionalEnv('IDLE_TIMEOUT_MS') ?? '');
const IDLE_TIMEOUT_MS = Number.isFinite(configuredSilence) && configuredSilence > 0 ? configuredSilence : 10 * 60_000;

/** Seconds below a minute, minutes above it — "0 min" would be a confusing thing to tell someone. */
const describeWindow = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);
/** `/model list` and autocomplete share one catalogue per guild; a restart of the server invalidates it. */
const CATALOG_TTL_MS = 60_000;

export type CatalogProvider = { id: string; name: string; models: string[] };

type Stream = {
  renderer: StreamRenderer;
  resolve: () => void;
  toolCalls: Array<{ tool: string; status?: string; input?: unknown }>;
  /** Re-armed on every event for this session; fires after `IDLE_TIMEOUT_MS` of silence. */
  watchdog?: Timer;
  timedOut: boolean;
  /** Part ids already written to the log, so a tool that reports several updates is listed once. */
  logged: Set<string>;
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
  private readonly catalogs = new Map<string, { at: number; providers: CatalogProvider[] }>();

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
    } catch (error) {
      // Anything thrown before the stream exists (a workspace that cannot provision, a provider block the
      // server rejects) would otherwise vanish into an unhandled rejection with no message in the channel.
      const message = error instanceof Error ? error.message : String(error);
      logger.error('prompt could not start', {
        chatKey,
        'code': diagnosisCode(message),
        'error': message.slice(0, 300),
      });
      await input.channel.send({ 'content': `⚠️ ${failureText(message)}`.slice(0, 1990) }).catch(() => undefined);
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
    const stream: Stream = {
      renderer,
      'resolve': idle.resolve,
      'toolCalls': [],
      'timedOut': false,
      'logged': new Set(),
    };
    this.streams.set(sessionId, stream);

    const rank = ['guest', 'member', 'trusted', 'admin', 'owner'][tierOf(input.guildId, input.member)];
    const prompt =
      `[#${input.channel.name} · ${input.actorName} · rank ${rank}]\n${input.text}` +
      memoryContext(input.guildId, input.text);

    try {
      await server.opencode.prompt(sessionId, prompt, models.primary(input.guildId));
      this.watch(sessionId, stream);
      await idle.promise;

      if (stream.timedOut) await this.recoverSession(server, chatKey, sessionId);
      const finalText = await server.opencode.lastText(sessionId).catch(() => '');
      const reasoning = await server.opencode.lastReasoning(sessionId).catch(() => '');
      await renderer.finish(finalText, {
        'mentionId': input.actorId,
        reasoning,
        ...(stream.timedOut
          ? {
              'note':
                `⏱️ interrupted after ${describeWindow(IDLE_TIMEOUT_MS)} without output. The session was aborted ` +
                'and the next message starts a fresh one — partial output follows.',
            }
          : {}),
      });
      sessions.touch(chatKey);
      // Snapshot the workspace: code edits need no approval precisely because they are always revertible.
      commitWorkspace(input.guildId, `agent: turn ${chatKey} ${new Date().toISOString()}`);

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
      logger.error('prompt failed', { chatKey, 'code': diagnosisCode(message), 'error': message.slice(0, 300) });
      await renderer.fail(failureText(message), { 'mentionId': input.actorId });
    } finally {
      clearTimeout(stream.watchdog);
      this.streams.delete(sessionId);
      await cancelApprovalsForSession(sessionId, this.client);
      for (const question of pendingQuestionsForSession(sessionId)) {
        logger.warn('cancelling unanswered question at end of turn', { 'requestId': question.requestId });
        cancelQuestion(question.requestId);
        await server.opencode.rejectQuestion(question.requestId, 'turn ended');
      }
    }
  }

  /**
   * Aborts the wedged turn and rebinds the chat to a fresh session. An interrupted session _sometimes_ answers
   * again, but not reliably — and a channel whose next prompt produces nothing is exactly the "it completely
   * stopped" failure. The old transcript stays on disk; memory injection carries durable facts into the new one.
   */
  private async recoverSession(
    server: Awaited<ReturnType<Supervisor['ensure']>>,
    chatKey: string,
    sessionId: string,
  ): Promise<void> {
    await server.opencode.abort(sessionId).catch(() => undefined);
    const fresh = await server.opencode.createSession(`${chatKey} (recovered after timeout)`).catch(() => undefined);
    if (!fresh) return;
    sessions.rotate(chatKey, fresh);
    logger.info('session rotated after timeout', { chatKey, 'abandoned': sessionId, 'fresh': fresh });
  }

  /** Arms (or re-arms) the silence timer: any event for a live stream proves the server is still working. */
  private watch(sessionId: string, stream: Stream): void {
    clearTimeout(stream.watchdog);
    stream.watchdog = setTimeout(() => {
      logger.warn('prompt went silent; aborting', { sessionId, 'silenceMs': IDLE_TIMEOUT_MS });
      stream.timedOut = true;
      stream.resolve();
    }, IDLE_TIMEOUT_MS);
  }

  handleEvent(guildId: string, event: AgentEvent): void {
    const sessionId = typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : undefined;
    const stream = sessionId ? this.streams.get(sessionId) : undefined;
    if (sessionId && stream) this.watch(sessionId, stream);

    if (stream && isDelta(event) && event.properties.field === 'text') {
      stream.renderer.push(event.properties.delta);
      return;
    }
    if (stream && isReasoningPart(event)) {
      stream.renderer.setReasoning(event.properties.part.id, event.properties.part.text);
      return;
    }
    if (stream && isToolPart(event)) {
      const part = event.properties.part;
      const status = part.state?.status ?? 'running';
      stream.toolCalls.push({ 'tool': part.tool ?? 'tool', 'status': part.state?.status, 'input': part.state?.input });
      stream.renderer.setStatus(`🔧 ${part.tool ?? 'tool'} · ${status}`);
      // One log line per tool call, at the first terminal status.
      if ((status === 'completed' || status === 'error') && !stream.logged.has(part.id)) {
        stream.logged.add(part.id);
        stream.renderer.addStep(part.tool ?? 'tool', status);
      }
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
    if (isQuestionAsked(event)) void this.handleQuestionAsked(guildId, event, stream);
  }

  /**
   * opencode's `question` tool blocks until answered. It is surfaced as a Discord card; if nobody answers
   * within the timeout the question is rejected so the agent continues instead of stalling the session.
   */
  private async handleQuestionAsked(guildId: string, event: QuestionAsked, stream: Stream | undefined): Promise<void> {
    const server = this.supervisor.get(guildId);
    const session = sessions.byOpenCodeId(event.properties.sessionID);
    const first = event.properties.questions[0]?.question ?? 'question';
    stream?.renderer.setStatus(`❓ ${first.slice(0, 140)}`);

    if (!server || !session) {
      logger.warn('question without server/session; rejecting', { guildId, 'requestID': event.properties.id });
      await server?.opencode.rejectQuestion(event.properties.id, 'session not bound');
      return;
    }

    const answers = await requestAnswers({
      'client': this.client,
      'guildId': guildId,
      'chatKey': session.chat_key,
      'channelId': session.channel_id,
      'sessionId': event.properties.sessionID,
      'requestId': event.properties.id,
      'questions': event.properties.questions,
    });

    if (!answers) {
      await server.opencode.rejectQuestion(event.properties.id, 'no answer in Discord');
      return;
    }
    const delivered = await server.opencode.replyQuestion(event.properties.id, answers);
    logger.info('question answered', { 'requestID': event.properties.id, answers, delivered });
    stream?.renderer.setStatus(`✅ answered: ${answers.flat().join(', ').slice(0, 120)}`);
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
    const stream = this.streams.get(event.properties.sessionID);

    // In vibe mode the server's own permission asks are screened too — otherwise an unattended guild would
    // still stop on every `bash`/`edit`, which is the opposite of the point.
    const actor = this.client.guilds.cache.get(guildId)?.members.cache.get(session.actor_id ?? '') ?? null;
    const tier = tierOf(guildId, actor);
    const screen = await screenPermission({
      guildId,
      tier,
      'permission': event.properties.permission,
      'patterns': event.properties.patterns,
    });
    if (screen.verdict !== 'ask') {
      const reply = screen.verdict === 'allow' ? 'once' : 'reject';
      const ok = await server.opencode.replyPermission(event.properties.id, reply);
      logger.info('permission auto-answered', {
        'requestID': event.properties.id,
        reply,
        'reason': screen.reason,
        'delivered': ok,
      });
      if (screen.verdict === 'allow') stream?.renderer.setStatus(`😎 vibe: ${event.properties.permission} allowed`);
      return;
    }

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

  /**
   * Provider/model catalogue for this guild. `spawn: false` is what autocomplete uses: it only reads a warm
   * server, because a keyboard interaction must not wait on a cold opencode start.
   */
  async catalog(guildId: string, guildName: string, options: { spawn?: boolean } = {}): Promise<CatalogProvider[]> {
    const cached = this.catalogs.get(guildId);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.providers;

    const server =
      options.spawn === false ? this.supervisor.get(guildId) : await this.supervisor.ensure(guildId, guildName);
    if (!server) return [];

    const providers = await server.opencode.catalog().catch(error => {
      logger.warn('catalog unavailable', { guildId, 'error': String(error).slice(0, 160) });
      return [] as CatalogProvider[];
    });
    if (providers.length > 0) this.catalogs.set(guildId, { 'at': Date.now(), 'providers': providers });
    return providers;
  }

  /** Called when the guild's model or provider wiring changes, so the next prompt re-provisions and re-reads. */
  forgetCatalog(guildId: string): void {
    this.catalogs.delete(guildId);
  }
}
