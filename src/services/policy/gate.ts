import { RANK_NAMES, config, isOwner, type GuildPolicy } from '@services/config.ts';
import { log } from '@utils/logger.ts';

import { SAFETY_QUESTIONS, askJev, jevMode, type JevAnswers } from './jev.ts';

import type { Capability, Risk } from '@services/bridge/capabilities.ts';
import type { GuildMember } from 'discord.js';

const logger = log('policy');

export type Tier = 0 | 1 | 2 | 3 | 4;
export type Verdict = 'allow' | 'ask' | 'deny';

export type Decision = {
  verdict: Verdict;
  layer: 'tier' | 'matrix' | 'tools' | 'mode' | 'vibe' | 'jev' | 'jev-degraded';
  reason: string;
  jev?: JevAnswers;
};

const RISK_ORDER: Risk[] = ['read', 'reversible', 'destructive', 'admin'];

/** Static ceiling table: what each rank may do without a human in the loop (layers 1–2 of PLAN.md §4). */
/** Exported so `/config show` can print the effective table instead of describing it in prose. */
export const CEILING: Record<Risk, Record<Tier, Verdict>> = {
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

/**
 * The ceiling a policy applies to one rank and risk class. A guild may override any single cell in
 * `policy.matrix`, which is how "trusted may not delete" is expressed without touching the code table.
 */
export function ceilingFor(
  policy: GuildPolicy,
  tier: Tier,
  risk: Risk,
): { verdict: Verdict; source: 'matrix' | 'tier' } {
  const override = policy.matrix[RANK_NAMES[tier]]?.[risk];
  return override ? { 'verdict': override, 'source': 'matrix' } : { 'verdict': CEILING[risk][tier], 'source': 'tier' };
}

const riskAtMost = (risk: Risk, max: GuildPolicy['vibe']['maxRisk']): boolean =>
  RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(max);

/** Extra approval demanded of the classes the code already calls dangerous. */
const DESTRUCTIVE_MARGIN = 0.2;
/** A "this is safe" reading is only worth acting on when Jev is reasonably sure of it. */
const SAFE_CLAIM_CONFIDENCE = 0.5;

/**
 * What vibe mode does with an action a human would otherwise have been asked about. Kept pure so the policy is
 * testable without a Jev call — `decide()` is the only thing that talks to the network.
 *
 * Vibe is "run it unless it looks dangerous", so it vetoes on evidence rather than on the absence of evidence:
 *
 * 1. above `vibe.maxRisk` → a human is asked (the guild said this class is off-limits);
 * 2. a `catastrophic` blast radius → refused, always, whatever the score;
 * 3. a destructive-class action Jev reads as destructive or reversible needs `minApproval + 0.2` — coarse
 *    readings are what let a permission grant look "reversible" at 0.51;
 * 4. a destructive-class action Jev calls `read_only` needs confidence, or a human decides — an unconfident
 *    "it's fine" is not a green light for a delete;
 * 5. otherwise it runs. No other branch asks, because then vibe would just be `ask` with more steps.
 */
export function vibeVerdict(input: { risk: Risk; vibe: GuildPolicy['vibe']; jev?: JevAnswers }): {
  verdict: Verdict;
  reason: string;
} {
  if (!riskAtMost(input.risk, input.vibe.maxRisk))
    return { 'verdict': 'ask', 'reason': `${input.risk} is above vibe.maxRisk=${input.vibe.maxRisk}` };
  if (input.vibe.screen === 'off') return { 'verdict': 'allow', 'reason': 'vibe: screening off' };

  const answers = input.jev;
  if (!answers)
    return input.vibe.askOnUncertain
      ? { 'verdict': 'ask', 'reason': 'vibe: jev unavailable and askOnUncertain is set' }
      : { 'verdict': 'allow', 'reason': 'vibe: jev unavailable, running it' };

  const blast = answers.blast_radius?.choice ?? 'unknown';
  const confidence = answers.blast_radius?.confidence ?? 0;
  const approval = answers.admin_would_approve?.noul ?? 0;
  const detailed = `vibe: jev ${blast}, approval ${approval.toFixed(2)}, confidence ${confidence.toFixed(2)}`;
  const dangerous = input.risk === 'destructive' || input.risk === 'admin';

  if (blast === 'catastrophic') return { 'verdict': 'deny', 'reason': detailed };
  // Jev calling something destructive is a veto on its own, whatever class the code assigned: the sandbox does
  // not make `rm -rf /var` safe just because the call is reversible by design.
  if (blast === 'destructive' && approval < input.vibe.minApproval) return { 'verdict': 'deny', 'reason': detailed };
  if (dangerous && (blast === 'destructive' || blast === 'reversible')) {
    const floor = Math.min(1, input.vibe.minApproval + DESTRUCTIVE_MARGIN);
    return approval < floor ? { 'verdict': 'deny', 'reason': detailed } : { 'verdict': 'allow', 'reason': detailed };
  }
  if (dangerous && blast === 'read_only' && confidence < SAFE_CLAIM_CONFIDENCE)
    return { 'verdict': 'ask', 'reason': `${detailed} — an unconfident "safe" reading` };
  return { 'verdict': 'allow', 'reason': detailed };
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
 * Layers 1–4 of the gate: explicit tool rules, the rank ceiling (with per-guild matrix overrides), the guild's
 * policy mode, and Jev for anything a human would otherwise be asked about.
 *
 * `ask` (default) keeps a human in the loop; `vibe` runs unattended and lets Jev veto what looks destructive;
 * `locked` refuses everything above `read` whatever the rank. Every branch fails closed.
 */
export async function decide(
  guildId: string,
  member: GuildMember | null,
  capability: Capability,
  args: Record<string, unknown>,
): Promise<Decision> {
  const tier = tierOf(guildId, member);
  const policy = config.policy(guildId);

  if (policy.tools.deny.includes(capability.name))
    return { 'verdict': 'deny', 'layer': 'tools', 'reason': `${capability.name} is on this guild's deny list` };
  if (policy.tools.allow.includes(capability.name))
    return { 'verdict': 'allow', 'layer': 'tools', 'reason': `${capability.name} is on this guild's allow list` };

  const ceiling = ceilingFor(policy, tier, capability.risk);
  // `locked` is a cap on the risk class, not on the rank: nothing above read runs for anyone.
  if (policy.mode === 'locked')
    return capability.risk === 'read'
      ? { 'verdict': 'allow', 'layer': 'mode', 'reason': 'locked mode: reads are allowed' }
      : { 'verdict': 'deny', 'layer': 'mode', 'reason': `locked mode: ${capability.risk} does not run here` };
  if (ceiling.verdict === 'deny')
    return {
      'verdict': 'deny',
      'layer': ceiling.source,
      'reason': `rank ${RANK_NAMES[tier]} may not run ${capability.risk} actions`,
    };

  if (capability.risk === 'read')
    return { 'verdict': 'allow', 'layer': 'tier', 'reason': `${capability.risk} is always readable` };

  if (policy.mode === 'vibe') {
    // `off` anywhere means the operator does not want Jev consulted at all; `shadow` observes without acting.
    const screen = jevMode === 'off' ? 'off' : policy.vibe.screen;
    const answers =
      screen === 'off' ? undefined : await askJev(jevState(guildId, tier, capability, args), SAFETY_QUESTIONS);
    const verdict = vibeVerdict({ 'risk': capability.risk, 'vibe': { ...policy.vibe, screen }, 'jev': answers });
    logger.info('vibe verdict', {
      'tool': capability.name,
      'risk': capability.risk,
      'verdict': verdict.verdict,
      'reason': verdict.reason,
    });
    if (screen === 'shadow' && answers)
      return { 'verdict': 'allow', 'layer': 'vibe', 'reason': `shadow: ${verdict.reason}`, 'jev': answers };
    return { 'verdict': verdict.verdict, 'layer': 'vibe', 'reason': verdict.reason, 'jev': answers };
  }

  if (jevMode === 'off')
    return {
      'verdict': ceiling.verdict,
      'layer': ceiling.source,
      'reason': `rank ${RANK_NAMES[tier]} ceiling for ${capability.risk} is ${ceiling.verdict}`,
    };

  const answers = await askJev(jevState(guildId, tier, capability, args), SAFETY_QUESTIONS);
  if (!answers)
    return {
      'verdict': jevMode === 'enforce' ? 'ask' : ceiling.verdict,
      'layer': 'jev-degraded',
      'reason': 'jev unavailable; falling back to the tier ceiling',
    };

  const blast = answers.blast_radius?.choice ?? 'unknown';
  const confidence = answers.blast_radius?.confidence ?? 0;
  const approval = answers.admin_would_approve?.noul ?? 0;
  logger.info('jev verdict', { 'tool': capability.name, blast, confidence, approval, 'mode': jevMode });

  if (jevMode === 'shadow')
    return {
      'verdict': ceiling.verdict,
      'layer': ceiling.source,
      'reason': `shadow: jev would judge ${blast}`,
      'jev': answers,
    };
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

/**
 * The opencode server asks permission for its own tools (`edit` outside `repo/`, `bash`, `webfetch`). In vibe
 * mode those are screened the same way bridge calls are, so an unattended guild does not simply answer every
 * card: only what Jev is willing to call non-destructive runs itself.
 */
export async function screenPermission(input: {
  guildId: string;
  tier: Tier;
  permission: string;
  patterns: string[];
}): Promise<{ verdict: Verdict; reason: string }> {
  const policy = config.policy(input.guildId);
  if (policy.mode !== 'vibe') return { 'verdict': 'ask', 'reason': 'policy mode is not vibe' };

  const shell = config.guild(input.guildId)?.shell.mode ?? 'docker';
  // The same `rm` is reversible inside a throwaway container and destructive on the host.
  const risk: Risk =
    input.permission === 'webfetch'
      ? 'reversible'
      : input.permission === 'bash'
        ? shell === 'docker'
          ? 'reversible'
          : 'destructive'
        : 'destructive';
  const screen = jevMode === 'off' ? 'off' : policy.vibe.screen;
  const answers =
    screen === 'off'
      ? undefined
      : await askJev(
          [
            `Guild: ${input.guildId}`,
            `Requester rank: ${RANK_NAMES[input.tier]}`,
            `Action: opencode permission "${input.permission}"`,
            `Targets: ${input.patterns.join(', ').slice(0, 800)}`,
            'The command runs inside a per-guild sandbox (docker by default) or on the host.',
          ].join('\n'),
          SAFETY_QUESTIONS,
        );
  return vibeVerdict({ risk, 'vibe': { ...policy.vibe, screen }, 'jev': answers });
}
