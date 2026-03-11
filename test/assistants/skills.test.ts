/**
 * Tests for Assistants API skill integration.
 *
 * Verifies that:
 * - Assistants store skills
 * - Runs inherit or override skills from their assistant
 * - Skills are resolved and injected into system content
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../../src/assistants/state';
import { skillsState } from '../../src/skills/state';
import { resolveSkills, buildSkillInstructions } from '../../src/skills/resolver';
import type { Assistant, Run, CreateRunRequest, CreateThreadAndRunRequest } from '../../src/assistants/types';
import type { Skill, SkillVersion, SkillAttachment, SkillReference, InlineSkill } from '../../src/skills/types';

// ==================== Helpers ====================

function makeVersion(version: number, body: string): SkillVersion {
  return {
    version,
    created_at: Math.floor(Date.now() / 1000),
    files: [{ path: 'SKILL.md', size: 100, content_type: 'text/markdown' }],
    manifest: { name: `Skill v${version}`, description: `Version ${version} desc`, body },
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

function createAssistantWithSkills(skills: SkillAttachment[]): Assistant {
  const assistant: Assistant = {
    id: state.generateAssistantId(),
    object: 'assistant',
    created_at: Math.floor(Date.now() / 1000),
    name: 'Test Assistant',
    description: null,
    model: 'gpt-4o',
    instructions: 'You are a helpful assistant.',
    tools: [],
    skills,
    metadata: {},
  };
  state.createAssistant(assistant);
  return assistant;
}

function createThreadAndRun(assistantId: string, runSkills?: SkillAttachment[]): { threadId: string; run: Run } {
  const threadId = state.generateThreadId();
  state.createThread({
    id: threadId,
    object: 'thread',
    created_at: Math.floor(Date.now() / 1000),
    metadata: {},
  });

  const assistant = state.getAssistant(assistantId)!;
  const run: Run = {
    id: state.generateRunId(),
    object: 'thread.run',
    created_at: Math.floor(Date.now() / 1000),
    thread_id: threadId,
    assistant_id: assistantId,
    status: 'queued',
    required_action: null,
    last_error: null,
    expires_at: null,
    started_at: null,
    cancelled_at: null,
    failed_at: null,
    completed_at: null,
    incomplete_details: null,
    model: assistant.model,
    instructions: null,
    tools: assistant.tools,
    skills: runSkills ?? assistant.skills,
    metadata: {},
    usage: null,
  };
  state.addRun(threadId, run);
  return { threadId, run };
}

// ==================== Tests ====================

describe('Assistants API - Skills Integration', () => {
  beforeEach(() => {
    state.restore({
      assistants: [],
      threads: [],
      messages: [],
      runs: [],
      runSteps: [],
    });
    skillsState.clear();
  });

  describe('Assistant creation with skills', () => {
    it('stores skill references on assistant', () => {
      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_abc' },
      ];
      const assistant = createAssistantWithSkills(skills);

      const retrieved = state.getAssistant(assistant.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.skills).toHaveLength(1);
      expect(retrieved!.skills[0]).toEqual({ type: 'skill_reference', skill_id: 'skill_abc' });
    });

    it('stores inline skills on assistant', () => {
      const inlineSkill: InlineSkill = {
        type: 'inline',
        name: 'My Inline Skill',
        description: 'An inline skill',
        source: {
          type: 'base64',
          media_type: 'text/markdown',
          data: Buffer.from('Be concise and direct').toString('base64'),
        },
      };
      const assistant = createAssistantWithSkills([inlineSkill]);

      const retrieved = state.getAssistant(assistant.id);
      expect(retrieved!.skills).toHaveLength(1);
      expect(retrieved!.skills[0].type).toBe('inline');
      expect((retrieved!.skills[0] as InlineSkill).name).toBe('My Inline Skill');
    });

    it('stores empty skills array when none provided', () => {
      const assistant = createAssistantWithSkills([]);
      expect(state.getAssistant(assistant.id)!.skills).toEqual([]);
    });

    it('stores mixed skill types', () => {
      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_one' },
        {
          type: 'inline',
          name: 'Inline',
          description: 'Inline desc',
          source: { type: 'base64', media_type: 'text/markdown', data: btoa('body') },
        },
        { type: 'skill_reference', skill_id: 'skill_two', version: 2 },
      ];
      const assistant = createAssistantWithSkills(skills);
      expect(state.getAssistant(assistant.id)!.skills).toHaveLength(3);
    });
  });

  describe('Assistant update with skills', () => {
    it('updates skills on existing assistant', () => {
      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_old' },
      ]);
      const updated = state.updateAssistant(assistant.id, {
        skills: [{ type: 'skill_reference', skill_id: 'skill_new' }],
      });
      expect(updated!.skills).toHaveLength(1);
      expect((updated!.skills[0] as SkillReference).skill_id).toBe('skill_new');
    });

    it('clears skills when updated to empty array', () => {
      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_abc' },
      ]);
      const updated = state.updateAssistant(assistant.id, { skills: [] });
      expect(updated!.skills).toEqual([]);
    });
  });

  describe('Run skill inheritance', () => {
    it('run inherits skills from assistant when none specified', () => {
      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_abc' },
      ];
      const assistant = createAssistantWithSkills(skills);
      const { run } = createThreadAndRun(assistant.id);

      expect(run.skills).toHaveLength(1);
      expect(run.skills[0]).toEqual(skills[0]);
    });

    it('run overrides assistant skills when specified', () => {
      const assistantSkills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_old' },
      ];
      const runSkills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_new' },
      ];
      const assistant = createAssistantWithSkills(assistantSkills);
      const { run } = createThreadAndRun(assistant.id, runSkills);

      expect(run.skills).toHaveLength(1);
      expect((run.skills[0] as SkillReference).skill_id).toBe('skill_new');
    });

    it('run with empty skills array overrides assistant skills', () => {
      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_abc' },
      ]);
      const { run } = createThreadAndRun(assistant.id, []);

      expect(run.skills).toEqual([]);
    });
  });

  describe('Skill resolution for runs', () => {
    it('resolves registered skill references from run', () => {
      const v1 = makeVersion(1, 'Use TypeScript best practices.');
      skillsState.createSkill(makeSkill('skill_ts', [v1], 1));

      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_ts' },
      ];
      const assistant = createAssistantWithSkills(skills);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('Skill v1');
      expect(resolved[0].body).toBe('Use TypeScript best practices.');
    });

    it('resolves specific version of skill reference', () => {
      const v1 = makeVersion(1, 'Old instructions');
      const v2 = makeVersion(2, 'New instructions');
      skillsState.createSkill(makeSkill('skill_versioned', [v1, v2], 1));

      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_versioned', version: 2 },
      ];
      const assistant = createAssistantWithSkills(skills);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      expect(resolved[0].body).toBe('New instructions');
    });

    it('resolves inline skills from run', () => {
      const body = 'Always respond in JSON format.';
      const inlineSkill: InlineSkill = {
        type: 'inline',
        name: 'JSON Mode',
        description: 'Forces JSON responses',
        source: {
          type: 'base64',
          media_type: 'text/markdown',
          data: Buffer.from(body).toString('base64'),
        },
      };

      const assistant = createAssistantWithSkills([inlineSkill]);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('JSON Mode');
      expect(resolved[0].body).toBe(body);
    });

    it('resolves mixed skill types from run', () => {
      const v1 = makeVersion(1, 'Registered skill body');
      skillsState.createSkill(makeSkill('skill_reg', [v1], 1));

      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_reg' },
        {
          type: 'inline',
          name: 'Inline Skill',
          description: 'desc',
          source: { type: 'base64', media_type: 'text/markdown', data: Buffer.from('Inline body').toString('base64') },
        },
      ];

      const assistant = createAssistantWithSkills(skills);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      expect(resolved).toHaveLength(2);
      expect(resolved[0].body).toBe('Registered skill body');
      expect(resolved[1].body).toBe('Inline body');
    });

    it('throws when skill reference not found', () => {
      const skills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'nonexistent' },
      ];
      const assistant = createAssistantWithSkills(skills);
      const { run } = createThreadAndRun(assistant.id);

      expect(() => resolveSkills(run.skills)).toThrow('Skill not found: nonexistent');
    });
  });

  describe('Skill instruction building for runs', () => {
    it('builds instruction block from resolved run skills', () => {
      const v1 = makeVersion(1, 'Be concise.');
      skillsState.createSkill(makeSkill('skill_concise', [v1], 1));

      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_concise' },
      ]);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      const instructions = buildSkillInstructions(resolved);

      expect(instructions).toContain('<!-- Attached Skills -->');
      expect(instructions).toContain('<skill name="Skill v1">');
      expect(instructions).toContain('Be concise.');
      expect(instructions).toContain('</skill>');
    });

    it('appends skill instructions to assistant instructions', () => {
      const v1 = makeVersion(1, 'Follow coding standards.');
      skillsState.createSkill(makeSkill('skill_standards', [v1], 1));

      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_standards' },
      ]);
      const { run } = createThreadAndRun(assistant.id);

      // Simulate what the runner does: build systemContent
      let systemContent = '';
      if (assistant.instructions) {
        systemContent += assistant.instructions;
      }
      if (run.instructions) {
        systemContent += (systemContent ? '\n\n' : '') + run.instructions;
      }

      const skills = run.skills.length > 0 ? run.skills : assistant.skills;
      if (skills.length > 0) {
        const resolved = resolveSkills(skills);
        if (resolved.length > 0) {
          systemContent += (systemContent ? '\n\n' : '') + buildSkillInstructions(resolved);
        }
      }

      expect(systemContent).toContain('You are a helpful assistant.');
      expect(systemContent).toContain('<skill name="Skill v1">');
      expect(systemContent).toContain('Follow coding standards.');
    });

    it('returns empty for runs without skills', () => {
      const assistant = createAssistantWithSkills([]);
      const { run } = createThreadAndRun(assistant.id);

      const skills = run.skills.length > 0 ? run.skills : assistant.skills;
      expect(skills).toHaveLength(0);

      const resolved = resolveSkills(skills);
      const instructions = buildSkillInstructions(resolved);
      expect(instructions).toBe('');
    });

    it('builds multiple skill blocks for multi-skill runs', () => {
      const v1 = makeVersion(1, 'First skill body');
      const v2 = makeVersion(1, 'Second skill body');
      skillsState.createSkill(makeSkill('skill_first', [v1], 1));
      skillsState.createSkill(makeSkill('skill_second', [v2], 1));

      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_first' },
        { type: 'skill_reference', skill_id: 'skill_second' },
      ]);
      const { run } = createThreadAndRun(assistant.id);

      const resolved = resolveSkills(run.skills);
      const instructions = buildSkillInstructions(resolved);

      expect(instructions).toContain('<skill name="Skill v1">');
      expect(instructions).toContain('First skill body');
      expect(instructions).toContain('Second skill body');
    });
  });

  describe('Run skill fallback logic', () => {
    it('prefers run skills over assistant skills when run skills non-empty', () => {
      const v1 = makeVersion(1, 'Assistant skill body');
      const v2 = makeVersion(1, 'Run skill body');
      skillsState.createSkill(makeSkill('skill_a', [v1], 1));
      skillsState.createSkill(makeSkill('skill_b', [v2], 1));

      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_a' },
      ]);
      const runSkills: SkillAttachment[] = [
        { type: 'skill_reference', skill_id: 'skill_b' },
      ];
      const { run } = createThreadAndRun(assistant.id, runSkills);

      // Simulate runner logic
      const skills = run.skills.length > 0 ? run.skills : assistant.skills;
      const resolved = resolveSkills(skills);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].body).toBe('Run skill body');
    });

    it('falls back to assistant skills when run skills empty', () => {
      const v1 = makeVersion(1, 'Assistant skill body');
      skillsState.createSkill(makeSkill('skill_a', [v1], 1));

      const assistant = createAssistantWithSkills([
        { type: 'skill_reference', skill_id: 'skill_a' },
      ]);

      // Create run with no skills override - simulate inheriting from assistant
      const run: Run = {
        id: state.generateRunId(),
        object: 'thread.run',
        created_at: Math.floor(Date.now() / 1000),
        thread_id: 'thread_test',
        assistant_id: assistant.id,
        status: 'queued',
        required_action: null,
        last_error: null,
        expires_at: null,
        started_at: null,
        cancelled_at: null,
        failed_at: null,
        completed_at: null,
        incomplete_details: null,
        model: 'gpt-4o',
        instructions: null,
        tools: [],
        skills: [], // Empty — should fall back
        metadata: {},
        usage: null,
      };

      const skills = run.skills.length > 0 ? run.skills : assistant.skills;
      const resolved = resolveSkills(skills);

      expect(resolved).toHaveLength(1);
      expect(resolved[0].body).toBe('Assistant skill body');
    });
  });
});
