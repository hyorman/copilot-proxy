import { skillsState } from './state.js';
import { SkillAttachment, SkillReference, InlineSkill, SkillVersion } from './types.js';

/**
 * Resolved skill content ready for injection into the model context.
 */
export interface ResolvedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Resolve an array of skill attachments into instruction text blocks.
 * - SkillReference: looks up the skill in state and reads the manifest body
 * - InlineSkill: decodes base64 source as a SKILL.md and extracts the body
 *
 * Returns an array of resolved skills. Throws on unresolvable references.
 */
export function resolveSkills(attachments: SkillAttachment[]): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'skill_reference') {
      resolved.push(resolveReference(attachment));
    } else if (attachment.type === 'inline') {
      resolved.push(resolveInline(attachment));
    }
  }

  return resolved;
}

function resolveReference(ref: SkillReference): ResolvedSkill {
  const skill = skillsState.getSkill(ref.skill_id);
  if (!skill) {
    throw new Error(`Skill not found: ${ref.skill_id}`);
  }

  let version: SkillVersion | undefined;
  if (ref.version === 'latest') {
    version = skill.versions.find((v) => v.version === skill.latest_version);
  } else if (typeof ref.version === 'number') {
    version = skill.versions.find((v) => v.version === ref.version);
  } else {
    // Default: use default_version
    version = skill.versions.find((v) => v.version === skill.default_version);
  }

  if (!version) {
    throw new Error(
      `Version ${ref.version ?? skill.default_version} not found for skill ${ref.skill_id}`
    );
  }

  return {
    name: version.manifest.name,
    description: version.manifest.description,
    body: version.manifest.body,
  };
}

function resolveInline(inline: InlineSkill): ResolvedSkill {
  // Inline skills provide their content as base64-encoded data.
  // For simplicity, treat the decoded content as the skill body directly.
  const decoded = Buffer.from(inline.source.data, 'base64').toString('utf-8');

  return {
    name: inline.name,
    description: inline.description,
    body: decoded,
  };
}

/**
 * Build a combined instruction block from resolved skills.
 * Returns a string to prepend/append to the system prompt, or empty string if no skills.
 */
export function buildSkillInstructions(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';

  const blocks = skills.map(
    (s) => `<skill name="${s.name}">\n${s.body}\n</skill>`
  );

  return `\n\n<!-- Attached Skills -->\n${blocks.join('\n\n')}`;
}
