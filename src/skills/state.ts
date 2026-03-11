import { generateId } from '../utils';
import { OpenAIListResponse, PaginationParams } from '../assistants/types';
import { Skill, SkillVersion, SkillResponse } from './types';

type PersistCallback = (data: SerializedSkillsState) => void;

export interface SerializedSkillsState {
  skills: [string, Skill][];
}

class SkillsState {
  private skills: Map<string, Skill> = new Map();
  private persistCallback: PersistCallback | null = null;
  private persistDebounceTimer: NodeJS.Timeout | null = null;
  private persistDebounceMs = 1000;

  setPersistCallback(callback: PersistCallback, debounceMs?: number): void {
    this.persistCallback = callback;
    if (debounceMs !== undefined) {
      this.persistDebounceMs = debounceMs;
    }
  }

  private triggerPersist(): void {
    if (!this.persistCallback) return;
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistCallback?.(this.serialize());
      this.persistDebounceTimer = null;
    }, this.persistDebounceMs);
  }

  generateSkillId(): string {
    return generateId('skill');
  }

  createSkill(skill: Skill): void {
    this.skills.set(skill.id, skill);
    this.triggerPersist();
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getSkillResponse(id: string): SkillResponse | undefined {
    const skill = this.skills.get(id);
    if (!skill) return undefined;
    return this.toSkillResponse(skill);
  }

  listSkills(params?: PaginationParams): OpenAIListResponse<SkillResponse> {
    const order = params?.order ?? 'desc';
    const sortedSkills = Array.from(this.skills.values()).sort((a, b) =>
      order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at
    );

    const limit = Math.min(params?.limit ?? 20, 100);
    const after = params?.after;
    const before = params?.before;

    let items = sortedSkills;

    if (after) {
      const afterIndex = items.findIndex((s) => s.id === after);
      if (afterIndex >= 0) {
        items = items.slice(afterIndex + 1);
      }
    }

    if (before) {
      const beforeIndex = items.findIndex((s) => s.id === before);
      if (beforeIndex >= 0) {
        items = items.slice(0, beforeIndex);
      }
    }

    const paginatedSkills = items.slice(0, limit);
    const hasMore = paginatedSkills.length < items.length;

    return {
      object: 'list',
      data: paginatedSkills.map((s) => this.toSkillResponse(s)),
      first_id: paginatedSkills.length > 0 ? paginatedSkills[0].id : null,
      last_id: paginatedSkills.length > 0 ? paginatedSkills[paginatedSkills.length - 1].id : null,
      has_more: hasMore,
    };
  }

  updateSkill(
    id: string,
    updates: { default_version?: number; metadata?: Record<string, string>; name?: string; description?: string }
  ): Skill | undefined {
    const skill = this.skills.get(id);
    if (!skill) return undefined;

    if (updates.default_version !== undefined) {
      skill.default_version = updates.default_version;
    }
    if (updates.metadata !== undefined) {
      skill.metadata = updates.metadata;
    }
    if (updates.name !== undefined) {
      skill.name = updates.name;
    }
    if (updates.description !== undefined) {
      skill.description = updates.description;
    }

    this.triggerPersist();
    return skill;
  }

  deleteSkill(id: string): boolean {
    const deleted = this.skills.delete(id);
    if (deleted) {
      this.triggerPersist();
    }
    return deleted;
  }

  addVersion(skillId: string, version: SkillVersion): Skill | undefined {
    const skill = this.skills.get(skillId);
    if (!skill) return undefined;

    skill.versions.push(version);
    skill.latest_version = version.version;

    this.triggerPersist();
    return skill;
  }

  getVersion(skillId: string, version: number): SkillVersion | undefined {
    const skill = this.skills.get(skillId);
    if (!skill) return undefined;
    return skill.versions.find((v) => v.version === version);
  }

  deleteVersion(skillId: string, version: number): Skill | undefined {
    const skill = this.skills.get(skillId);
    if (!skill) return undefined;

    skill.versions = skill.versions.filter((v) => v.version !== version);

    // Recompute latest_version from remaining versions
    if (skill.versions.length > 0) {
      skill.latest_version = Math.max(...skill.versions.map((v) => v.version));
    } else {
      skill.latest_version = 0;
    }

    // Reset default_version if it pointed to the deleted version
    if (skill.default_version === version) {
      skill.default_version = skill.latest_version;
    }

    this.triggerPersist();
    return skill;
  }

  toSkillResponse(skill: Skill): SkillResponse {
    const { versions, ...response } = skill;
    return response as SkillResponse;
  }

  serialize(): SerializedSkillsState {
    return {
      skills: Array.from(this.skills.entries()),
    };
  }

  restore(data: Partial<SerializedSkillsState>): void {
    if (!data.skills) return;
    this.skills.clear();
    for (const [id, skill] of data.skills) {
      this.skills.set(id, skill);
    }
  }

  clear(): void {
    this.skills.clear();
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
  }
}

export const skillsState = new SkillsState();
