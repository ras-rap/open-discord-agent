import type { Message, TextChannel } from 'discord.js';

const LIMIT = 1990;
const EDIT_INTERVAL_MS = 1200;
/** Reserved for the `<@id> ` mention that prefixes the answer, so the first chunk still fits Discord's 2000. */
const MENTION_RESERVE = 32;

/**
 * Splits on lines while keeping code fences balanced: a chunk that cuts through a fenced block closes it
 * and the next chunk reopens the same language, so Discord never renders a broken block.
 */
export function chunkMessage(text: string, limit = LIMIT): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let fence: string | undefined;

  const flush = () => {
    const body = fence ? `${current}\n\`\`\`` : current;
    chunks.push(body.replace(/^\n+|\n+$/g, ''));
    current = fence ? `\`\`\`${fence.slice(3)}\n` : '';
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith('```');
    const projected = current.length + line.length + 1;
    if (projected > limit && current.length > 0) flush();
    if (line.length > limit) {
      for (let offset = 0; offset < line.length; offset += limit - 40) {
        if (current.length > 0) flush();
        chunks.push(line.slice(offset, offset + limit - 40));
      }
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
    if (isFence) fence = fence ? undefined : trimmed.slice(0, trimmed.length).trimEnd();
  }
  if (current.length > 0) chunks.push(current.replace(/^\n+|\n+$/g, ''));
  return chunks.filter(chunk => chunk.length > 0);
}

const MAX_LOG_STEPS = 20;

/**
 * One live Discord message per turn. While the prompt runs it is edited at most once per interval and shows
 * the partial answer, the current tool call, and the model's thinking as it is published.
 *
 * When the turn ends it stays in the channel as the turn's **log**: elapsed time, what the agent did, and its
 * chain of thought. The answer itself goes out as a separate message so it can ping whoever asked — the log is
 * the working record, the answer is the reply.
 */
export class StreamRenderer {
  private buffer = '';
  private status = '';
  private message?: Message;
  private timer?: Timer;
  private closed = false;
  /** Terminal tool calls, in order, for the log. */
  private readonly steps: string[] = [];
  /** Reasoning parts keyed by part id: the server re-publishes a part as it grows, so the latest wins. */
  private readonly reasoning = new Map<string, string>();
  private readonly startedAt = Date.now();
  private elapsed = 0;

  constructor(
    private readonly channel: TextChannel,
    private readonly preview: string,
  ) {}

  async start(): Promise<void> {
    this.message = await this.channel.send({ 'content': this.preview });
  }

  private thinkingText(): string {
    return [...this.reasoning.values()]
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private get content(): string {
    const status = this.status ? `\n\n> ${this.status}` : '';
    const body = this.buffer.length > 1500 ? `…${this.buffer.slice(-1500)}` : this.buffer;
    const composed = `${body}${status}`.trim();
    if (composed.length > 0) return composed.slice(0, LIMIT);
    // No answer text yet: show the thinking as it arrives, which is the only visible progress during a long
    // reasoning pass (the server publishes reasoning as parts, never as text deltas).
    const thinking = this.thinkingText();
    if (thinking.length === 0) return this.preview;
    const tail = thinking.length > 700 ? `…${thinking.slice(-700)}` : thinking;
    return `🧠 thinking…\n\n> ${tail.split('\n').join('\n> ')}`.slice(0, LIMIT);
  }

  /** Called on every terminal tool call: the log lists what happened, not each status transition. */
  addStep(tool: string, status: string): void {
    this.steps.push(`${status === 'error' ? '✗' : '✓'} \`${tool}\``);
    if (this.steps.length > MAX_LOG_STEPS) this.steps.shift();
    this.schedule();
  }

  setReasoning(partId: string, text: string): void {
    this.reasoning.set(partId, text);
    this.schedule();
  }

  /**
   * The finished log: header, steps, then the chain of thought as a blockquote. Discord caps a message at 2000
   * characters, so the thinking is what gets trimmed — steps are the part that answers "what did it do".
   */
  private logContent(note?: string): string {
    const seconds = Math.max(1, Math.round(this.elapsed / 1000));
    const header = `🧠 log · ${seconds}s · ${this.steps.length} step${this.steps.length === 1 ? '' : 's'}`;
    const parts = note ? [note, header] : [header];
    if (this.steps.length > 0) parts.push(this.steps.join('\n'));

    const thinking = this.thinkingText();
    if (thinking.length > 0) {
      const used = parts.join('\n').length;
      const budget = LIMIT - used - 16;
      const quoted = thinking.length > budget ? `…${thinking.slice(-budget)}` : thinking;
      parts.push(`> ${quoted.split('\n').join('\n> ')}`);
    }

    return parts.join('\n\n').slice(0, LIMIT);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      await this.flush();
    }, EDIT_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (!this.message || this.closed) return;
    const next = this.content;
    if (next === this.message.content) return;
    this.message = await this.message.edit({ 'content': next }).catch(() => this.message);
  }

  push(delta: string): void {
    this.buffer += delta;
    this.schedule();
  }

  setStatus(line: string): void {
    this.status = line.slice(0, 180);
    this.schedule();
  }

  /**
   * Posts the answer as a new message (`mentionId` pings the asker on the first chunk) and deletes the
   * progress preview. `note` is prepended — it is how a timeout explains itself above the partial output.
   */
  async finish(
    finalText: string,
    options: { mentionId?: string; note?: string; reasoning?: string } = {},
  ): Promise<void> {
    this.elapsed = Date.now() - this.startedAt;
    // The session is authoritative: live parts are provisional prefixes, so they are replaced, not appended.
    if (options.reasoning) {
      this.reasoning.clear();
      this.reasoning.set('final', options.reasoning);
    }
    this.closed = true;
    this.stop();

    const body = [options.note, finalText.trim() || this.buffer.trim() || '(no output)'].filter(Boolean).join('\n\n');
    const prefix = options.mentionId ? `<@${options.mentionId}> ` : '';
    const chunks = chunkMessage(body, prefix.length > 0 ? LIMIT - MENTION_RESERVE : LIMIT);
    // Post first, then rewrite the preview: a failed send must not leave the channel with the log and no answer.
    for (const [index, chunk] of chunks.entries())
      await this.channel.send({ 'content': `${index === 0 ? prefix : ''}${chunk}`.slice(0, LIMIT) });
    await this.publishLog(options.note);
  }

  /**
   * The failure goes where the asker is looking — the live message — with the steps it had managed, so the log
   * of a failed turn still says what the agent was doing when it broke.
   */
  async fail(text: string, options: { mentionId?: string } = {}): Promise<void> {
    this.elapsed = Date.now() - this.startedAt;
    this.closed = true;
    this.stop();
    const mention = options.mentionId ? `<@${options.mentionId}> ` : '';
    const steps = this.steps.length > 0 ? `\n\n> ${this.steps.join('\n> ')}` : '';
    const content = `${mention}⚠️ ${text}${steps}`.slice(0, LIMIT);
    if (!this.message) await this.channel.send({ 'content': content });
    else await this.message.edit({ 'content': content }).catch(() => undefined);
  }

  private async publishLog(note?: string): Promise<void> {
    const log = this.logContent(note);
    if (!this.message) {
      await this.channel.send({ 'content': log }).catch(() => undefined);
      return;
    }
    this.message = await this.message.edit({ 'content': log }).catch(() => this.message);
  }
}
