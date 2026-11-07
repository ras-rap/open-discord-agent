import { config, isOwner } from '@services/config.ts';
import { log } from '@utils/logger.ts';

import { SAFETY_QUESTIONS, askJev, jevMode, type JevAnswers } from './jev.ts';

import type { Capability, Risk } from '@services/bridge/capabilities.ts';
import type { GuildMember } from 'discord.js';

const logger = log('policy');

export type Tier = 0 | 1 | 2 | 3 | 4;
export type Verdict = 'allow' | 'ask' | 'deny';

export type Decision = {
  verdict: Verdict;
  layer: 'tier' | 'jev' | 'jev-degraded';
  reason: string;
  jev?: JevAnswers;
};

/** Static ceiling table: what each rank may do without a human in the loop (layers 1–2 of PLAN.md §4). */
const CEILING: Record<Risk, Record<Tier, Verdict>> = {
  'read': { '0': 'allow', '1': 'allow', '2': 'allow', '3': 'allow', '4': 'allow' },
  'reversible': { '0': 'deny', '1': 'ask', '2': 'allow', '3': 'allow', '4': 'allow' },
  'destructive': { '0': 'deny', '1': 'deny', '2': 'ask', '3': 'allow', '4': 'allow' },
  'admin': { '0': 'deny', '1': 'deny', '2': 'deny', '3': 'ask', '4': 'allow' },
};

export function tierOf(guildId: string, member: GuildMember | null): Tier {
  if (!member) return 0;
  if (isOwner(member.id) || member.id === member.guild.ownerId) return 4;
  const guildConfig = config.guild(guildId);
  if (guildConfig?.roles.admin.some(id => member.roles.cache.has(id))) return 3;
  if (guildConfig?.roles.trusted.some(id => member.roles.cache.has(id))) return 2;
  return 1;
}

const jevState = (guildId: string, tier: Tier, capability: Capability, args: Record<string, unknown>) =>
  [
    `Guild: ${guildId}`,
    `Requester rank: ${['guest', 'member', 'trusted', 'admin', 'owner'][tier]}`,
    `Tool: ${capability.name} (${capability.risk})`,
    `Tool purpose: ${capability.description}`,
    `Arguments: ${JSON.stringify(args).slice(0, 1500)}`,
  ].join('\n');

/**
 * Layers 1–3 of the gate. Deterministic tier ceilings decide the obvious cases; Jev is consulted only for
 * non-read actions whose ceiling is not `deny`, and only in shadow (log) or enforce (override) mode.
 */
export async function decide(
  guildId: string,
  member: GuildMember | null,
  capability: Capability,
  args: Record<string, unknown>,
): Promise<Decision> {
  const tier = tierOf(guildId, member);
  const ceiling = CEILING[capability.risk][tier];
  if (ceiling === 'deny')
    return { 'verdict': 'deny', 'layer': 'tier', 'reason': `rank ${tier} may not run ${capability.risk} actions` };

  if (capability.risk === 'read' || jevMode === 'off')
    return {
      'verdict': ceiling,
      'layer': 'tier',
      'reason': `rank ${tier} ceiling for ${capability.risk} is ${ceiling}`,
    };

  const answers = await askJev(jevState(guildId, tier, capability, args), SAFETY_QUESTIONS);
  if (!answers)
    return {
      'verdict': jevMode === 'enforce' ? 'ask' : ceiling,
      'layer': 'jev-degraded',
      'reason': 'jev unavailable; falling back to tier ceiling',
    };

  const blast = answers.blast_radius?.choice ?? 'unknown';
  const confidence = answers.blast_radius?.confidence ?? 0;
  const approval = answers.admin_would_approve?.noul ?? 0;
  logger.info('jev verdict', { 'tool': capability.name, blast, confidence, approval, 'mode': jevMode });

  if (jevMode === 'shadow')
    return { 'verdict': ceiling, 'layer': 'tier', 'reason': `shadow: jev would judge ${blast}`, 'jev': answers };
  if (blast === 'catastrophic' || approval < 0.5)
    return {
      'verdict': 'deny',
      'layer': 'jev',
      'reason': `jev: ${blast}, approval ${approval.toFixed(2)}`,
      'jev': answers,
    };

  if ((blast === 'read_only' || blast === 'reversible') && approval >= 0.9 && confidence >= 0.85)
    return {
      'verdict': 'allow',
      'layer': 'jev',
      'reason': `jev: ${blast} with ${confidence.toFixed(2)} confidence`,
      'jev': answers,
    };

  return {
    'verdict': 'ask',
    'layer': 'jev',
    'reason': `jev: ${blast}, approval ${approval.toFixed(2)} needs a human`,
    'jev': answers,
  };
}
