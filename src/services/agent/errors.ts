/**
 * Turns the provider/transport failures that actually happen in production into the one sentence an operator
 * can act on. Anything unmatched is left alone: inventing a diagnosis for an unknown error is worse than
 * showing it verbatim.
 *
 * The strings come from the pinned server and the three tiers it can reach (Go subscription, free tier, an
 * OpenAI-compatible endpoint), plus Discord's own interaction window.
 */
export type Diagnosis = { code: string; title: string; hint: string };

const RULES: Array<{ code: string; pattern: RegExp; title: string; hint: string }> = [
  {
    'code': 'go-subscription',
    'pattern': /free usage exceeded|subscribe to go|go subscription/i,
    'title': 'The model call fell through to the free tier.',
    'hint': 'Run `bun run auth` (or set `OPENCODE_GO_API_KEY`) so a Go-entitled key is stored, then `bun run doctor`.',
  },
  {
    'code': 'auth',
    'pattern': /\b(401|403)\b|unauthori[sz]ed|invalid (api )?key|authentication failed|no api key/i,
    'title': 'The provider rejected the credential.',
    'hint': 'Check the key in `.env` for the provider named in `/model`, then run `bun run doctor`.',
  },
  {
    'code': 'model-unavailable',
    'pattern': /model[^\n]{0,40}(not found|not supported|does not exist|unknown)|no such model/i,
    'title': 'That model is not available from this provider.',
    'hint': 'Run `/model list` to see what the server actually offers here, then `/model set` to switch.',
  },
  {
    'code': 'rate-limit',
    'pattern': /\b429\b|rate.?limit|too many requests|quota/i,
    'title': 'The provider is rate limiting.',
    'hint': 'Wait a moment, or switch model with `/model set` if this guild has another provider configured.',
  },
  {
    'code': 'context',
    'pattern': /context (length|window)|too many tokens|maximum context/i,
    'title': 'The conversation no longer fits the model context.',
    'hint': 'Run `/new` to start a fresh session (memory survives), or switch to a model with a larger context.',
  },
  {
    'code': 'network',
    'pattern': /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|network/i,
    'title': 'The provider endpoint is unreachable.',
    'hint': 'Check the base URL in `config/providers.json` / `.env`, DNS, and egress from this host.',
  },
  {
    'code': 'tool-support',
    'pattern': /tool[_ ]?call|tools? (is|are) not supported|function calling/i,
    'title': 'This model cannot call tools.',
    'hint':
      'Pick a tool-capable model with `/model set`; model entries in `config/providers.json` accept `"toolCall": true`.',
  },
  {
    'code': 'interaction-expired',
    'pattern': /unknown interaction|10062/i,
    'title': 'Discord expired this interaction.',
    'hint':
      'Likely a second process on the same token (`.data/bot.lock` blocks that) or a paused host — `/ping` shows the clock and latency.',
  },
];

export function diagnoseFailure(message: string): Diagnosis | undefined {
  for (const rule of RULES) if (rule.pattern.test(message)) return rule;
  return undefined;
}

/** The one string that reaches the channel: the diagnosis when we have one, the raw text when we do not. */
export function failureText(message: string): string {
  const diagnosis = diagnoseFailure(message);
  return diagnosis ? `**${diagnosis.title}**\n> ${diagnosis.hint}` : message;
}

/** Short label for the log line, so failures group by cause instead of by exact text. */
export const diagnosisCode = (message: string) => diagnoseFailure(message)?.code ?? 'unclassified';
