import { memory } from '@services/memory/store.ts';

import { readSkill } from './skills.ts';

export type Proposal = {
  name: string;
  content: string;
  rationale: string;
  previous?: string;
  added: string[];
  removed: string[];
  lessonCount: number;
};

const SKILL_NAME = 'learned-playbook';
const MAX_LESSONS = 12;

const header = (title: string) => `---
name: ${SKILL_NAME}
description: Procedures this server has taught the agent through corrections, failures, and successes.
title: ${title}
---

# ${title}

Use these when the situation matches. They were derived from this server's own history; prefer fresh tool
output when the two disagree, and say which one you used.
`;

const section = (title: string, lines: string[]) =>
  lines.length > 0 ? `\n## ${title}\n${lines.map(line => `- ${line}`).join('\n')}\n` : '';

/** Smallest useful diff: which lines the new proposal adds and drops relative to what is on disk. */
const lineDiff = (previous: string, next: string): { added: string[]; removed: string[] } => {
  const before = new Set(previous.split('\n').map(line => line.trim()));
  const after = new Set(next.split('\n').map(line => line.trim()));
  return {
    'added': [...after].filter(line => line.length > 0 && !before.has(line)),
    'removed': [...before].filter(line => line.length > 0 && !after.has(line)),
  };
};

/**
 * Turns the lessons the reflector stored into a candidate SKILL.md. Only lessons with evidence behind them
 * (importance or repeated use) are promoted, so the playbook stays short enough to be worth loading.
 */
export function buildSkillProposal(guildId: string): Proposal | undefined {
  const lessons = memory
    .search(guildId, 'lesson procedure avoid prefer always never run', MAX_LESSONS * 2)
    .filter(hit => hit.kind === 'lesson');
  const ranked = [...lessons]
    .sort((left, right) => right.importance + right.uses * 0.05 - (left.importance + left.uses * 0.05))
    .slice(0, MAX_LESSONS);
  if (ranked.length < 3) return undefined;

  const title = 'Learned playbook';
  const content = [
    header(title),
    section(
      'Procedures',
      ranked.map(hit => hit.text.replace(/\s+/g, ' ').trim()),
    ),
    section('Provenance', [
      `compiled from ${ranked.length} lessons on ${new Date().toISOString().slice(0, 10)}`,
      `memory ids: ${ranked.map(hit => `#${hit.id}`).join(', ')}`,
    ]),
  ].join('');

  const previous = readSkill(guildId, SKILL_NAME);
  const diff = lineDiff(previous ?? '', content);
  if (previous && diff.added.length === 0 && diff.removed.length === 0) return undefined;

  return {
    'name': SKILL_NAME,
    content,
    'rationale': `${ranked.length} lessons, top importance ${ranked[0]?.importance.toFixed(2)}`,
    ...(previous ? { previous } : {}),
    'added': diff.added,
    'removed': diff.removed,
    'lessonCount': ranked.length,
  };
}

/** Renders the proposal for a Discord embed: fenced diff plus the rationale. */
export function renderProposal(proposal: Proposal): string {
  const added = proposal.added.slice(0, 12).map(line => `+ ${line.slice(0, 140)}`);
  const removed = proposal.removed.slice(0, 8).map(line => `- ${line.slice(0, 140)}`);
  return [
    `skill: \`${proposal.name}\` (${proposal.lessonCount} lessons)`,
    proposal.rationale,
    '',
    '```diff',
    ...(added.length > 0 ? added : ['+ (no new lines)']),
    ...removed,
    '```',
  ]
    .join('\n')
    .slice(0, 3500);
}
