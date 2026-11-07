import type { Message, TextChannel } from "discord.js";

const LIMIT = 1990;
const EDIT_INTERVAL_MS = 1200;

/**
 * Splits on lines while keeping code fences balanced: a chunk that cuts through a fenced block closes it
 * and the next chunk reopens the same language, so Discord never renders a broken block.
 */
export function chunkMessage(text: string, limit = LIMIT): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  let fence: string | undefined;

  const flush = () => {
    const body = fence ? `${current}\n\`\`\`` : current;
    chunks.push(body.replace(/^\n+|\n+$/g, ""));
    current = fence ? `\`\`\`${fence.slice(3)}\n` : "";
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith("```");
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
  if (current.length > 0) chunks.push(current.replace(/^\n+|\n+$/g, ""));
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * One live Discord message that follows a running prompt: text deltas are coalesced to at most one edit
 * per interval, tool activity is shown as a status line, and the final answer replaces the preview.
 */
export class StreamRenderer {
  private buffer = "";
  private status = "";
  private message?: Message;
  private timer?: Timer;
  private closed = false;

  constructor(
    private readonly channel: TextChannel,
    private readonly preview: string,
  ) {}

  async start(): Promise<void> {
    this.message = await this.channel.send({ content: this.preview });
  }

  private get content(): string {
    const status = this.status ? `\n\n> ${this.status}` : "";
    const body = this.buffer.length > 1500 ? `…${this.buffer.slice(-1500)}` : this.buffer;
    const composed = `${body}${status}`.trim();
    return composed.length > 0 ? composed.slice(0, LIMIT) : this.preview;
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
    this.message = await this.message.edit({ content: next }).catch(() => this.message);
  }

  push(delta: string): void {
    this.buffer += delta;
    this.schedule();
  }

  setStatus(line: string): void {
    this.status = line.slice(0, 180);
    this.schedule();
  }

  /** Replaces the preview with the authoritative final text, sending extra chunks as follow-up messages. */
  async finish(finalText: string): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const chunks = chunkMessage(finalText.trim() || this.buffer.trim() || "(no output)");
    if (!this.message) {
      for (const chunk of chunks) await this.channel.send({ content: chunk });
      return;
    }
    await this.message.edit({ content: chunks[0] ?? "(no output)" }).catch(() => undefined);
    for (const chunk of chunks.slice(1)) await this.channel.send({ content: chunk });
  }

  async fail(text: string): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.message) await this.channel.send({ content: `⚠️ ${text}`.slice(0, LIMIT) });
    else await this.message.edit({ content: `⚠️ ${text}`.slice(0, LIMIT) }).catch(() => undefined);
  }
}
