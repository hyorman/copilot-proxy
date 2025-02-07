import { describe, it, expect, beforeEach } from 'vitest';
import { resolveSkills, buildSkillInstructions, ResolvedSkill } from '../../src/skills/resolver.js';
import { skillsState } from '../../src/skills/state.js';
import type { Skill, SkillVersion, SkillAttachment, SkillReference, InlineSkill } from '../../src/skills/types.js';

function makeVersion(version: number, body: string): SkillVersion {
  return {
    version,
    created_at: Math.floor(Date.now() / 1000),
    files: [{ path: 'SKILL.md', size: 100, content_type: 'text/markdown' }],
    manifest: { name: `Skill v${version}`, description: `Version ${version}`, body },
  };
}

function makeSkill(id: string, versions: SkillVersion[], defaultVersion: number): Skill {
  const latest = versions.reduce((max, v) => Math.max(max, v.version), 0);
  return {
    id,
    object: 'skill',
    created_at: Math.floor(Date.now() / 1000),
    name: versions[0]?.manifest.name ?? 'Test',
    description: versions[0]?.manifest.description ?? '',
    default_version: defaultVersion,
    latest_version: latest,
    versions,
    metadata: {},
  };
}

describe('resolveSkills', () => {
  beforeEach(() => {
    skillsState.clear();
  });

  it('resolves skill_reference using default version when version omitted', () => {
    const v1 = makeVersion(1, 'v1 body');
    const v2 = makeVersion(2, 'v2 body');
    skillsState.createSkill(makeSkill('skill_abc', [v1, v2], 1));

    const result = resolveSkills([{ type: 'skill_reference', skill_id: 'skill_abc' }]);

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('v1 body');
    expect(result[0].name).toBe('Skill v1');
  });

  it('resolves skill_reference with version="latest"', () => {
    const v1 = makeVersion(1, 'old');
    const v3 = makeVersion(3, 'newest');
    skillsState.createSkill(makeSkill('skill_ver', [v1, v3], 1));

    const result = resolveSkills([
      { type: 'skill_reference', skill_id: 'skill_ver', version: 'latest' },
    ]);

    expect(result[0].body).toBe('newest');
  });

  it('resolves skill_reference with specific version number', () => {
    const v1 = makeVersion(1, 'first');
    const v5 = makeVersion(5, 'fifth');
    skillsState.createSkill(makeSkill('skill_multi', [v1, v5], 1));

    const result = resolveSkills([
      { type: 'skill_reference', skill_id: 'skill_multi', version: 5 },
    ]);

    expect(result[0].body).toBe('fifth');
  });

  it('throws when skill_id does not exist', () => {
    expect(() =>
      resolveSkills([{ type: 'skill_reference', skill_id: 'skill_missing' }])
    ).toThrow('Skill not found');
  });

  it('throws when requested version does not exist', () => {
    skillsState.createSkill(makeSkill('skill_noV', [makeVersion(1, 'only')], 1));

    expect(() =>
      resolveSkills([{ type: 'skill_reference', skill_id: 'skill_noV', version: 99 }])
    ).toThrow(/Version 99 not found/);
  });

  it('decodes inline skill from base64', () => {
    const bodyText = 'Inline skill content with special chars: é ñ ü';
    const inline: InlineSkill = {
      type: 'inline',
      name: 'My Inline',
      description: 'Inline desc',
      source: { type: 'base64', media_type: 'text/plain', data: Buffer.from(bodyText).toString('base64') },
    };

    const result = resolveSkills([inline]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('My Inline');
    expect(result[0].body).toBe(bodyText);
  });

  it('resolves mixed references and inline skills', () => {
    skillsState.createSkill(makeSkill('skill_ref', [makeVersion(1, 'ref body')], 1));
    const inline: InlineSkill = {
      type: 'inline',
      name: 'Inline',
      description: 'desc',
      source: { type: 'base64', media_type: 'text/plain', data: Buffer.from('inline body').toString('base64') },
    };

    const result = resolveSkills([
      { type: 'skill_reference', skill_id: 'skill_ref' },
      inline,
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].body).toBe('ref body');
    expect(result[1].body).toBe('inline body');
  });
});

describe('buildSkillInstructions', () => {
  it('returns empty string for empty array', () => {
    expect(buildSkillInstructions([])).toBe('');
  });

  it('wraps skills in XML tags with header', () => {
    const skills: ResolvedSkill[] = [
      { name: 'alpha', description: 'Alpha skill', body: 'Alpha body' },
    ];
    const result = buildSkillInstructions(skills);
    expect(result).toContain('<!-- Attached Skills -->');
    expect(result).toContain('<skill name="alpha">');
    expect(result).toContain('Alpha body');
    expect(result).toContain('</skill>');
  });

  it('wraps multiple skills in separate tags', () => {
    const skills: ResolvedSkill[] = [
      { name: 'a', description: '', body: 'Body A' },
      { name: 'b', description: '', body: 'Body B' },
    ];
    const result = buildSkillInstructions(skills);
    expect(result).toContain('<skill name="a">');
    expect(result).toContain('<skill name="b">');
  });
});
