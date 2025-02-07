import { describe, it, expect, beforeEach } from 'vitest';
import { skillsState } from '../../src/skills/state.js';
import type { Skill, SkillVersion, SkillManifest } from '../../src/skills/types.js';

function makeManifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return { name: 'Test Skill', description: 'A test skill', body: '# Test', ...overrides };
}

function makeVersion(version = 1, overrides?: Partial<SkillVersion>): SkillVersion {
  return {
    version,
    created_at: Math.floor(Date.now() / 1000),
    files: [{ path: 'SKILL.md', size: 100, content_type: 'text/markdown' }],
    manifest: makeManifest(),
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<Skill>): Skill {
  return {
    id: 'skill_test123',
    object: 'skill',
    created_at: Math.floor(Date.now() / 1000),
    name: 'Test Skill',
    description: 'A test skill',
    default_version: 1,
    latest_version: 1,
    versions: [makeVersion(1)],
    metadata: {},
    ...overrides,
  };
}

describe('SkillsState', () => {
  beforeEach(() => {
    skillsState.clear();
  });

  describe('generateSkillId', () => {
    it('returns a string starting with "skill_"', () => {
      expect(skillsState.generateSkillId()).toMatch(/^skill_/);
    });

    it('generates unique IDs', () => {
      expect(skillsState.generateSkillId()).not.toBe(skillsState.generateSkillId());
    });
  });

  describe('CRUD', () => {
    it('creates and retrieves a skill', () => {
      const skill = makeSkill();
      skillsState.createSkill(skill);
      expect(skillsState.getSkill(skill.id)).toEqual(skill);
    });

    it('returns undefined for nonexistent skill', () => {
      expect(skillsState.getSkill('skill_nope')).toBeUndefined();
    });

    it('getSkillResponse returns skill without versions', () => {
      const skill = makeSkill();
      skillsState.createSkill(skill);
      const resp = skillsState.getSkillResponse(skill.id);
      expect(resp).toBeDefined();
      expect(resp!.id).toBe(skill.id);
      expect(resp!.name).toBe(skill.name);
      expect((resp as any).versions).toBeUndefined();
    });

    it('updates mutable fields', () => {
      const skill = makeSkill();
      skillsState.createSkill(skill);
      const updated = skillsState.updateSkill(skill.id, {
        name: 'Updated',
        metadata: { env: 'prod' },
      });
      expect(updated?.name).toBe('Updated');
      expect(updated?.metadata).toEqual({ env: 'prod' });
    });

    it('returns undefined when updating nonexistent skill', () => {
      expect(skillsState.updateSkill('skill_nope', { name: 'X' })).toBeUndefined();
    });

    it('deletes a skill', () => {
      const skill = makeSkill();
      skillsState.createSkill(skill);
      expect(skillsState.deleteSkill(skill.id)).toBe(true);
      expect(skillsState.getSkill(skill.id)).toBeUndefined();
    });

    it('returns false when deleting nonexistent skill', () => {
      expect(skillsState.deleteSkill('skill_nope')).toBe(false);
    });
  });

  describe('listSkills', () => {
    beforeEach(() => {
      for (let i = 0; i < 5; i++) {
        skillsState.createSkill(
          makeSkill({ id: `skill_${i}`, name: `Skill ${i}`, created_at: 1000 + i })
        );
      }
    });

    it('lists all skills with default params', () => {
      const result = skillsState.listSkills();
      expect(result.object).toBe('list');
      expect(result.data).toHaveLength(5);
      expect(result.first_id).toBeDefined();
      expect(result.last_id).toBeDefined();
    });

    it('respects limit', () => {
      const result = skillsState.listSkills({ limit: 2 });
      expect(result.data).toHaveLength(2);
      expect(result.has_more).toBe(true);
    });

    it('has_more is false when all fit', () => {
      expect(skillsState.listSkills({ limit: 10 }).has_more).toBe(false);
    });

    it('supports after cursor pagination', () => {
      const first = skillsState.listSkills({ limit: 2 });
      const second = skillsState.listSkills({ limit: 2, after: first.last_id! });
      expect(second.data[0].id).not.toBe(first.data[0].id);
      expect(second.data).toHaveLength(2);
    });

    it('orders descending by default', () => {
      const result = skillsState.listSkills();
      // created_at: 1004 > 1003 > ... (desc order)
      expect(result.data[0].created_at).toBeGreaterThan(result.data[1].created_at);
    });

    it('supports ascending order', () => {
      const result = skillsState.listSkills({ order: 'asc' });
      expect(result.data[0].created_at).toBeLessThan(result.data[1].created_at);
    });

    it('returns empty list when no skills', () => {
      skillsState.clear();
      const result = skillsState.listSkills();
      expect(result.data).toHaveLength(0);
      expect(result.has_more).toBe(false);
      expect(result.first_id).toBeNull();
      expect(result.last_id).toBeNull();
    });
  });

  describe('version management', () => {
    let skill: Skill;

    beforeEach(() => {
      skill = makeSkill();
      skillsState.createSkill(skill);
    });

    it('addVersion increments latest_version', () => {
      const v2 = makeVersion(2);
      const updated = skillsState.addVersion(skill.id, v2);
      expect(updated?.latest_version).toBe(2);
      expect(updated?.versions).toHaveLength(2);
    });

    it('getVersion retrieves specific version', () => {
      skillsState.addVersion(skill.id, makeVersion(2));
      expect(skillsState.getVersion(skill.id, 2)?.version).toBe(2);
    });

    it('getVersion returns undefined for missing version', () => {
      expect(skillsState.getVersion(skill.id, 99)).toBeUndefined();
    });

    it('deleteVersion removes the version', () => {
      skillsState.addVersion(skill.id, makeVersion(2));
      const updated = skillsState.deleteVersion(skill.id, 2);
      expect(updated?.versions).toHaveLength(1);
      expect(skillsState.getVersion(skill.id, 2)).toBeUndefined();
    });
  });

  describe('toSkillResponse', () => {
    it('strips versions from skill', () => {
      const skill = makeSkill({ metadata: { a: 'b' } });
      const resp = skillsState.toSkillResponse(skill);
      expect(resp.id).toBe(skill.id);
      expect(resp.metadata).toEqual({ a: 'b' });
      expect((resp as any).versions).toBeUndefined();
    });
  });

  describe('serialization', () => {
    it('serialize/restore round-trips correctly', () => {
      const s1 = makeSkill({ id: 'skill_a' });
      const s2 = makeSkill({ id: 'skill_b' });
      skillsState.createSkill(s1);
      skillsState.createSkill(s2);

      const serialized = skillsState.serialize();
      skillsState.clear();
      expect(skillsState.listSkills().data).toHaveLength(0);

      skillsState.restore(serialized);
      expect(skillsState.getSkill('skill_a')).toEqual(s1);
      expect(skillsState.getSkill('skill_b')).toEqual(s2);
    });

    it('restores empty state gracefully', () => {
      skillsState.restore({ skills: [] });
      expect(skillsState.listSkills().data).toHaveLength(0);
    });
  });
});
