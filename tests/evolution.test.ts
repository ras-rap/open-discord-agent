import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { buildSkillProposal, renderProposal } from '@services/evolution/proposals.ts';
import { commitWorkspace, readSkill, writeSkill } from '@services/evolution/skills.ts';
import { Memory } from '@services/memory/store.ts';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

const GUILD = `test-${Date.now().toString(36)}`;

describe('memory store (continued)', () => {
  test('lessons are recalled by a procedural query', () => {
    const memory = new Memory(new Database(':memory:'));
    memory.add({ 'guildId': 'g', 'kind': 'lesson', 'key': 'deploy', 'text': 'always run bun install before tests' });
    const hits = memory.search('g', 'run tests');
    expect(hits.some(hit => hit.kind === 'lesson')).toBe(true);
  });
});

describe('skill proposals', () => {
  test('needs at least three lessons before proposing anything', () => {
    expect(buildSkillProposal(`empty-${Date.now().toString(36)}`)).toBeUndefined();
  });

  test('renders a fenced diff for the approval card', () => {
    const rendered = renderProposal({
      'name': 'learned-playbook',
      'content': '# x',
      'rationale': '3 lessons',
      'added': ['always run bun install before tests'],
      'removed': [],
      'lessonCount': 3,
    });
    expect(rendered).toContain('```diff');
    expect(rendered).toContain('+ always run bun install before tests');
  });
});

describe('skill files are versioned in the workspace git repo', () => {
  test('writes a SKILL.md and commits it', () => {
    const workspace = resolve(paths.workspaces, GUILD);
    try {
      commitWorkspace(GUILD, 'agent: init workspace');
      const written = writeSkill(GUILD, 'learned-playbook', '# Playbook\n\n- be terse\n', 'test-owner');
      expect(written.created).toBe(true);
      expect(written.version).toBe(1);
      expect(readSkill(GUILD, 'learned-playbook')).toContain('be terse');

      const history = Bun.spawnSync(['git', 'log', '--oneline'], { 'cwd': workspace, 'stdout': 'pipe' });
      expect(history.stdout.toString()).toContain('learned-playbook');
    } finally {
      if (existsSync(workspace)) rmSync(workspace, { 'recursive': true, 'force': true });
    }
  });
});
