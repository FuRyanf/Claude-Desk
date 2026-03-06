import { describe, expect, it } from 'vitest';

import { sortSkillsForDisplay, type SkillUsageMap } from '../../src/lib/skillUsage';

describe('skill usage ranking', () => {
  it('sorts pinned skills first, then most recently used, then alphabetical', () => {
    const skills = [
      {
        id: 'alpha',
        name: 'Alpha',
        description: '',
        entryPoints: [],
        path: '/tmp/workspace/.claude/skills/alpha',
        relativePath: '.claude/skills/alpha/SKILL.md',
        warning: null
      },
      {
        id: 'beta',
        name: 'Beta',
        description: '',
        entryPoints: [],
        path: '/tmp/workspace/.claude/skills/beta',
        relativePath: '.claude/skills/beta/SKILL.md',
        warning: null
      },
      {
        id: 'charlie',
        name: 'Charlie',
        description: '',
        entryPoints: [],
        path: '/tmp/workspace/.claude/skills/charlie',
        relativePath: '.claude/skills/charlie/SKILL.md',
        warning: null
      }
    ];

    const usageMap: SkillUsageMap = {
      '/tmp/workspace::beta': { pinned: true, lastUsedAt: 5 },
      '/tmp/workspace::charlie': { pinned: false, lastUsedAt: 10 },
      '/tmp/workspace::alpha': { pinned: false, lastUsedAt: 2 }
    };

    expect(sortSkillsForDisplay(skills, '/tmp/workspace', usageMap).map((skill) => skill.id)).toEqual([
      'beta',
      'charlie',
      'alpha'
    ]);
  });
});
