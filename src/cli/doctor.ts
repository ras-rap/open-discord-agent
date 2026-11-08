import { existsSync } from 'node:fs';

import { assertPinnedBinary } from '@services/agent/binary.ts';
import { effectiveModel, knownProviderIds, modelAllowlist, modelRef } from '@services/agent/models.ts';
import { providerSummary, providersFilePath } from '@services/agent/providers.ts';
import { capabilities } from '@services/bridge/capabilities.ts';
import { GO_CHAT_ENDPOINT, config, paths } from '@services/config.ts';
import { consoleToken, jevMode } from '@services/policy/jev.ts';
import { shellStatus } from '@services/workspace/shell.ts';
import { DISCORD_CLIENT_ID, DISCORD_TOKEN } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

const logger = log('doctor');

type Check = { name: string; severity: 'ok' | 'warn' | 'error'; detail: string };

/**
 * A syntactically plausible token is not a working one: Discord answers 401 for revoked/rotated tokens, which
 * otherwise surfaces as "started fine, never answers".
 */
async function discordTokenCheck(): Promise<Check> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      'headers': { 'authorization': `Bot ${DISCORD_TOKEN}` },
      'signal': AbortSignal.timeout(8000),
    });
    if (!response.ok)
      return {
        'name': 'discord token',
        'severity': 'error',
        'detail': `HTTP ${response.status} — copy a fresh token into .env`,
      };
    const bot = (await response.json()) as { username?: string; id?: string };
    return {
      'name': 'discord token',
      'severity': 'ok',
      'detail': `bot ${bot.username ?? '?'} (${bot.id ?? DISCORD_CLIENT_ID})`,
    };
  } catch (error) {
    return {
      'name': 'discord token',
      'severity': 'warn',
      'detail': `could not reach discord.com: ${String(error).slice(0, 120)}`,
    };
  }
}

/** One row per provider the deployment resolves, so a missing credential is named instead of inferred later. */
function providerChecks(): Check[] {
  return providerSummary()
    .filter(provider => provider.source === 'config' || provider.ready || provider.id === 'opencode-go')
    .map(provider => ({
      'name': `provider ${provider.id}`,
      'severity': provider.ready ? 'ok' : 'warn',
      'detail': provider.ready
        ? `${provider.label}${provider.models.length > 0 ? ` · ${provider.models.length} declared model(s)` : ' · catalogue models'}`
        : `no credential — set ${provider.keyEnv ?? 'its key'}`,
    }));
}

/** Role models are validated exactly as a prompt would validate them, so a typo fails here and not at answer time. */
function roleChecks(): Check[] {
  return (['primary', 'fast'] as const).map(role => {
    const resolved = effectiveModel(role);
    try {
      modelRef(resolved.id);
      return { 'name': `model ${role}`, 'severity': 'ok' as const, 'detail': `${resolved.id} (${resolved.source})` };
    } catch (error) {
      return {
        'name': `model ${role}`,
        'severity': 'error' as const,
        'detail': error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Pre-flight report. Warnings (e.g. no docker daemon on a dev machine) never block boot: the shell runner
 * fails closed per call with an explicit message instead. Errors do block.
 */
async function main(): Promise<void> {
  const checks: Check[] = [];

  try {
    const { binary, version } = await assertPinnedBinary();
    checks.push({ 'name': 'opencode binary', 'severity': 'ok', 'detail': `${version} at ${binary}` });
  } catch (error) {
    checks.push({
      'name': 'opencode binary',
      'severity': 'error',
      'detail': error instanceof Error ? error.message : String(error),
    });
  }

  checks.push(await discordTokenCheck());
  checks.push(...providerChecks());
  checks.push(...roleChecks());
  checks.push({
    'name': 'model allowlist',
    'severity': 'ok',
    'detail':
      modelAllowlist().length > 0
        ? `pinned to ${modelAllowlist().length} model(s) by MODEL_ALLOWLIST`
        : `open — any model from ${knownProviderIds().length} known providers (set MODEL_ALLOWLIST to pin)`,
  });
  checks.push({
    'name': 'extra providers',
    'severity': 'ok',
    'detail': existsSync(providersFilePath()) ? providersFilePath() : 'none (config/providers.json absent)',
  });
  const token = consoleToken();
  checks.push({
    'name': 'jev',
    'severity': token ? 'ok' : jevMode === 'enforce' ? 'error' : 'warn',
    'detail': `mode=${jevMode} token=${token ? 'present' : 'missing (run `bun run auth` to shadow-calibrate)'}`,
  });

  const shell = await shellStatus();
  const shellOk = shell.mode === 'host' || shell.docker;
  checks.push({
    'name': 'shell sandbox',
    'severity': shellOk ? 'ok' : 'warn',
    'detail': `mode=${shell.mode} docker=${shell.docker ? shell.detail : `unavailable — ${shell.detail}`}${shellOk ? '' : ' (shell calls will refuse until the daemon is reachable)'}`,
  });

  checks.push({ 'name': 'bridge', 'severity': 'ok', 'detail': `${config.bridge.host}:${config.bridge.port}` });

  // Go and the free tier are different endpoints; this proves the stored credential is entitled to the models
  // the bot actually uses, instead of discovering "Free usage exceeded, subscribe to Go" at answer time. It is
  // only meaningful when a role actually runs on Go, so another provider's deployment never sees a red line.
  const usesGo = [effectiveModel('primary').id, effectiveModel('fast').id].some(id => id.startsWith('opencode-go/'));
  if (token && usesGo)
    try {
      const response = await fetch(GO_CHAT_ENDPOINT, {
        'method': 'POST',
        'headers': {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'x-opencode-session': `ses_doctor_${Date.now()}`,
        },
        'body': JSON.stringify({
          'model': 'crouton-alpha-free',
          'messages': [{ 'role': 'user', 'content': 'ok' }],
          'max_tokens': 16,
        }),
        'signal': AbortSignal.timeout(20_000),
      });
      const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 160);
      checks.push({
        'name': 'go subscription',
        'severity': response.ok ? 'ok' : 'error',
        'detail': `${response.status} ${body}`,
      });
    } catch (error) {
      checks.push({ 'name': 'go subscription', 'severity': 'error', 'detail': String(error).slice(0, 140) });
    }

  // Discord expires interactions after 3s, so a skewed host clock shows up as evry command failing with 10062.
  try {
    const response = await fetch('https://discord.com/api/v10/gateway', {
      'method': 'HEAD',
      'signal': AbortSignal.timeout(5000),
    });
    const header = response.headers.get('date');
    const skewMs = header ? Date.now() - new Date(header).getTime() : 0;
    checks.push({
      'name': 'clock skew',
      'severity': Math.abs(skewMs) > 5000 ? 'warn' : 'ok',
      'detail': `${skewMs}ms vs discord.com${Math.abs(skewMs) > 5000 ? ' — interactions will expire before we answer; fix NTP' : ''}`,
    });
  } catch (error) {
    checks.push({
      'name': 'clock skew',
      'severity': 'warn',
      'detail': `could not reach discord.com: ${String(error).slice(0, 120)}`,
    });
  }
  checks.push({ 'name': 'capabilities', 'severity': 'ok', 'detail': `${capabilities.length} discord tools` });
  checks.push({ 'name': 'data dir', 'severity': existsSync(paths.data) ? 'ok' : 'error', 'detail': paths.data });
  checks.push({
    'name': 'guilds enabled',
    'severity': 'ok',
    'detail': `${Object.keys(config.raw()).length} in config/guilds.json`,
  });

  for (const check of checks) {
    const tag = check.severity === 'ok' ? '✅' : check.severity === 'warn' ? '⚠️ ' : '❌';
    logger.info(`${tag} ${check.name}`, { 'detail': check.detail });
  }
  const errors = checks.filter(check => check.severity === 'error');
  if (errors.length > 0) {
    logger.error('doctor found blocking problems', { 'failed': errors.map(check => check.name) });
    process.exit(1);
  }
}

await main();
