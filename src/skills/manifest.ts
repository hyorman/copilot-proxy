import { SkillManifest, SkillFile } from './types';

/**
 * Parse a SKILL.md manifest file to extract metadata
 * @param content - Raw string content of a SKILL.md file
 * @returns Parsed SkillManifest object
 * @throws Error if frontmatter is invalid or required fields are missing
 */
export function parseManifest(content: string): SkillManifest {
  const lines = content.split('\n');

  // Find opening --- (must be the first non-blank line)
  let openingIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].trim() === '---') {
      openingIndex = i;
    }
    break;
  }

  if (openingIndex === -1) {
    throw new Error('No YAML frontmatter found. SKILL.md must start with --- delimiter.');
  }

  // Find closing ---
  let closingIndex = -1;
  for (let i = openingIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new Error('Invalid YAML frontmatter. Missing closing --- delimiter.');
  }

  // Extract frontmatter content
  const frontmatterLines = lines.slice(openingIndex + 1, closingIndex);

  // Parse key-value pairs
  const metadata: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '') continue;

    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmedLine.substring(0, colonIndex).trim();
    const value = trimmedLine.substring(colonIndex + 1).trim();

    metadata[key] = value;
  }

  // Validate required fields
  if (!metadata.name || metadata.name === '') {
    throw new Error('SKILL.md frontmatter must contain a "name" field.');
  }

  if (!metadata.description || metadata.description === '') {
    throw new Error('SKILL.md frontmatter must contain a "description" field.');
  }

  // Extract body (everything after closing ---)
  const body = lines.slice(closingIndex + 1).join('\n').trim();

  return {
    name: metadata.name,
    description: metadata.description,
    body,
  };
}

/**
 * Find the SKILL.md manifest file in an array of uploaded files
 * @param files - Array of uploaded files
 * @returns The matching SkillFile
 * @throws Error if no manifest file or multiple manifest files are found
 */
export function findManifestFile(files: SkillFile[]): SkillFile {
  const manifestFiles = files.filter((file) => {
    const basename = file.path.split('/').pop()?.toLowerCase();
    return basename === 'skill.md';
  });

  if (manifestFiles.length === 0) {
    throw new Error('No SKILL.md manifest file found in the uploaded bundle.');
  }

  if (manifestFiles.length > 1) {
    throw new Error('Multiple SKILL.md manifest files found. Only one is allowed.');
  }

  return manifestFiles[0];
}

/**
 * Validate and parse a skill bundle
 * @param files - Array of files from the uploaded bundle
 * @returns Object containing parsed manifest and the manifest file reference
 * @throws Error if validation fails
 */
export function validateBundle(
  files: SkillFile[]
): { manifest: SkillManifest; manifestFile: SkillFile } {
  const manifestFile = findManifestFile(files);
  const manifest = parseManifest(manifestFile.content.toString('utf-8'));

  return {
    manifest,
    manifestFile,
  };
}
