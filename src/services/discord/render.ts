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

/**
 * One live Discord message that follows a running prompt: text deltas are coalesced to at most one edit per
 * interval and tool activity shows as a status line. When the turn ends the preview is deleted and the answer
 * is posted as its own message — the preview is scratch space for progress, not part of the transcript, so all
 * of its tool lines disappear with it and the answer can ping whoever asked.
 */
export class StreamRenderer {
  private buffer = '';
  private status = '';
  private message?: Message;
  private timer?: Timer;
  private closed = false;

  constructor(
    private readonly channel: TextChannel,
    private readonly preview: string,
  ) {}

  async start(): Promise<void> {
    this.message = await this.channel.send({ 'content': this.preview });
  }

  private get content(): string {
    const status = this.status ? `\n\n> ${this.status}` : '';
    const body = this.buffer.length > 1500 ? `…${this.buffer.slice(-1500)}` : this.buffer;
    const composed = `${body}${status}`.trim();
    return composed.length > 0 ? composed.slice(0, LIMIT) : this.preview;
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
  async finish(finalText: string, options: { mentionId?: string; note?: string } = {}): Promise<void> {
    this.closed = true;
    this.stop();
    const body = [options.note, finalText.trim() || this.buffer.trim() || '(no output)'].filter(Boolean).join('\n\n');
    const prefix = options.mentionId ? `<@${options.mentionId}> ` : '';
    const chunks = chunkMessage(body, prefix.length > 0 ? LIMIT - MENTION_RESERVE : LIMIT);
    // Post first, then drop the preview: a failed send must not leave the channel with the progress message
    // deleted and no answer at all.
    for (const [index, chunk] of chunks.entries())
      await this.channel.send({ 'content': `${index === 0 ? prefix : ''}${chunk}`.slice(0, LIMIT) });
    await this.dropPreview();
  }

  /** Keeps the preview and turns it into the error: the asker is looking at it, so it is the place to answer. */
  async fail(text: string, options: { mentionId?: string } = {}): Promise<void> {
    this.closed = true;
    this.stop();
    const mention = options.mentionId ? `<@${options.mentionId}> ` : '';
    const content = `${mention}⚠️ ${text}`.slice(0, LIMIT);
    if (!this.message) await this.channel.send({ 'content': content });
    else await this.message.edit({ 'content': content }).catch(() => undefined);
  }

  private async dropPreview(): Promise<void> {
    if (!this.message) return;
    const preview = this.message;
    this.message = undefined;
    await preview.delete().catch(() => undefined);
  }
}
