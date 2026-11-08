import { createOpencodeClient, type OpencodeClient, type TextPart } from '@opencode-ai/sdk';
import { log } from '@utils/logger.ts';

import type { AgentEvent } from './events.ts';
import type { ModelRef } from './models.ts';

const logger = log('opencode');

export type Health = { healthy: boolean; version: string };

/**
 * The pinned server requires HTTP basic auth (`opencode:<password>`) on every request, so the client is
 * built once with a fetch that injects the header. `POST /permission/{id}/reply` is not wrapped by the
 * SDK's root client at all, hence the raw calls below.
 */
export class Opencode {
  readonly baseUrl: string;
  readonly client: OpencodeClient;
  private readonly auth: Record<string, string>;

  constructor(port: number, password: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.auth = { 'authorization': `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    const baseFetch = globalThis.fetch;
    this.client = createOpencodeClient({
      'baseUrl': this.baseUrl,
      'fetch': (request: Request) => {
        const headers = new Headers(request.headers);
        for (const [name, value] of Object.entries(this.auth)) headers.set(name, value);
        return baseFetch(new Request(request, { headers }));
      },
    });
  }

  async health(): Promise<Health | undefined> {
    const res = await fetch(`${this.baseUrl}/global/health`, {
      'headers': this.auth,
      'signal': AbortSignal.timeout(3000),
    });
    return res.ok ? ((await res.json()) as Health) : undefined;
  }

  async createSession(title: string): Promise<string> {
    const res = await this.client.session.create({ 'body': { title } });
    if (res.error || !res.data) throw new Error(`session.create failed: ${JSON.stringify(res.error)}`);
    return res.data.id;
  }

  async prompt(sessionID: string, text: string, model: ModelRef): Promise<void> {
    const res = await this.client.session.promptAsync({
      'path': { 'id': sessionID },
      'body': { model, 'parts': [{ 'type': 'text', text }] },
    });
    if (res.error) throw new Error(`session.prompt failed: ${JSON.stringify(res.error)}`);
    if (res.response && !res.response.ok && res.response.status !== 204)
      throw new Error(`session.prompt failed: HTTP ${res.response.status}`);
  }

  async abort(sessionID: string): Promise<void> {
    await this.client.session.abort({ 'path': { 'id': sessionID } });
  }

  async isBusy(sessionID: string): Promise<boolean> {
    const res = await this.client.session.status();
    const status = res.data?.[sessionID];
    return Boolean(status && status.type !== 'idle');
  }

  async lastText(sessionID: string): Promise<string> {
    const res = await this.client.session.messages({ 'path': { 'id': sessionID } });
    const assistant = [...(res.data ?? [])].reverse().find(entry => entry.info.role === 'assistant');
    return (assistant?.parts ?? [])
      .filter((part): part is TextPart => part.type === 'text')
      .map(part => part.text)
      .join('');
  }

  async replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/permission/${encodeURIComponent(requestID)}/reply`, {
      'method': 'POST',
      'headers': { ...this.auth, 'content-type': 'application/json' },
      'body': JSON.stringify({ reply }),
    });
    if (!res.ok)
      logger.warn('permission reply rejected', {
        requestID,
        'status': res.status,
        'body': (await res.text()).slice(0, 200),
      });

    return res.ok;
  }

  /** Answers are one array of selected labels per question, in the order the server asked them. */
  async replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/question/${encodeURIComponent(requestID)}/reply`, {
      'method': 'POST',
      'headers': { ...this.auth, 'content-type': 'application/json' },
      'body': JSON.stringify({ 'answers': answers }),
    });
    if (!res.ok)
      logger.warn('question reply rejected', {
        requestID,
        'status': res.status,
        'body': (await res.text()).slice(0, 200),
      });

    return res.ok;
  }

  /** Cancels a pending question; the tool completes as `error` and the agent keeps running. */
  async rejectQuestion(requestID: string, reason = 'no answer in Discord'): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/question/${encodeURIComponent(requestID)}/reject`, {
      'method': 'POST',
      'headers': { ...this.auth, 'content-type': 'application/json' },
      'body': JSON.stringify({ 'reason': reason }),
    });
    if (!res.ok) logger.warn('question reject rejected', { requestID, 'status': res.status });

    return res.ok;
  }

  /** SSE pump with reconnect. Frames are `data: <json>` separated by a blank line, as observed in §0.1. */
  subscribe(onEvent: (event: AgentEvent) => void, signal: AbortSignal): void {
    const pump = async () => {
      while (!signal.aborted)
        try {
          const res = await fetch(`${this.baseUrl}/event`, { 'headers': this.auth, signal });
          if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { 'stream': true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const data = buffer
                .slice(0, boundary)
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim())
                .join('');
              buffer = buffer.slice(boundary + 2);
              if (data)
                try {
                  onEvent(JSON.parse(data) as AgentEvent);
                } catch (error) {
                  logger.debug('unparseable event frame', { 'error': String(error) });
                }

              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          logger.warn('event stream dropped; retrying', { 'error': String(error).slice(0, 160) });
          await Bun.sleep(750);
        }
    };
    void pump();
  }
}
