/**
 * OpenAI-Compatible Skills API Types
 *
 * Skills are versioned file bundles anchored by a SKILL.md manifest.
 * They are NOT function tools — they are reusable instruction + code bundles.
 */

// Re-export common types for consumers
export { OpenAIListResponse, PaginationParams } from '../assistants/types.js';

// ==================== Skill File Types ====================

/**
 * A single file within a skill bundle.
 */
export interface SkillFile {
  /** Relative path within the bundle (e.g., "my_skill/SKILL.md") */
  path: string;
  /** Raw file content */
  content: Buffer;
  /** File size in bytes */
  size: number;
}

/**
 * Parsed SKILL.md manifest metadata and body.
 */
export interface SkillManifest {
  /** Skill name from SKILL.md frontmatter */
  name: string;
  /** Skill description from SKILL.md frontmatter */
  description: string;
  /** Markdown body content after frontmatter */
  body: string;
}

/**
 * Metadata about a file stored in a skill version.
 */
export interface SkillVersionFile {
  /** Relative path within the bundle */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type (guessed from file extension) */
  content_type: string;
}

/**
 * A specific version of a skill with its complete manifest and file manifest.
 */
export interface SkillVersion {
  /** Version number (integer, starts at 1) */
  version: number;
  /** Creation timestamp (Unix seconds) */
  created_at: number;
  /** File manifest for this version */
  files: SkillVersionFile[];
  /** Parsed manifest from SKILL.md */
  manifest: SkillManifest;
}

/**
 * A complete skill object with full versioning history.
 */
export interface Skill {
  /** Skill ID (e.g., "skill_abc123") */
  id: string;
  /** Object type identifier */
  object: 'skill';
  /** Creation timestamp (Unix seconds) */
  created_at: number;
  /** Skill name from manifest */
  name: string;
  /** Skill description from manifest */
  description: string;
  /** Default version number */
  default_version: number;
  /** Latest version number */
  latest_version: number;
  /** All versions of this skill */
  versions: SkillVersion[];
  /** User-defined metadata as key-value pairs */
  metadata: Record<string, string>;
}

/**
 * API response for a skill (summary without versions array).
 */
export interface SkillResponse {
  /** Skill ID (e.g., "skill_abc123") */
  id: string;
  /** Object type identifier */
  object: 'skill';
  /** Creation timestamp (Unix seconds) */
  created_at: number;
  /** Skill name from manifest */
  name: string;
  /** Skill description from manifest */
  description: string;
  /** Default version number */
  default_version: number;
  /** Latest version number */
  latest_version: number;
  /** User-defined metadata as key-value pairs */
  metadata: Record<string, string>;
}

/**
 * Request payload for updating a skill.
 */
export interface UpdateSkillRequest {
  /** Set the default version */
  default_version?: number;
  /** Update user-defined metadata */
  metadata?: Record<string, string>;
}

// ==================== Skill Attachment Types ====================

/**
 * Reference to an existing skill by ID and optional version.
 */
export interface SkillReference {
  /** Attachment type identifier */
  type: 'skill_reference';
  /** Skill ID to reference */
  skill_id: string;
  /** Version number or 'latest' (defaults to default_version if omitted) */
  version?: number | 'latest';
}

/**
 * Inline skill definition embedded directly in a request.
 */
export interface InlineSkill {
  /** Attachment type identifier */
  type: 'inline';
  /** Skill name */
  name: string;
  /** Skill description */
  description: string;
  /** Source material as base64-encoded data */
  source: {
    /** Source encoding type */
    type: 'base64';
    /** MIME type of the data (e.g., "application/zip") */
    media_type: string;
    /** Base64-encoded content */
    data: string;
  };
}

/**
 * Union type for skill attachments — either a reference or an inline definition.
 */
export type SkillAttachment = SkillReference | InlineSkill;
