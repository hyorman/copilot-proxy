import { describe, it, expect } from 'vitest';
import { parseManifest, findManifestFile, validateBundle } from '../../src/skills/manifest';
import type { SkillFile } from '../../src/skills/types';

describe('parseManifest', () => {
  it('parses valid manifest with name, description, body', () => {
    const content = `---
name: Test Skill
description: A test skill
---
This is the body`;
    const result = parseManifest(content);
    expect(result.name).toBe('Test Skill');
    expect(result.description).toBe('A test skill');
    expect(result.body).toBe('This is the body');
  });

  it('throws when no frontmatter delimiters', () => {
    expect(() => parseManifest('Just some content')).toThrow('No YAML frontmatter found');
  });

  it('throws when missing closing delimiter', () => {
    const content = `---
name: Test Skill
description: A test skill
Body content`;
    expect(() => parseManifest(content)).toThrow('Missing closing --- delimiter');
  });

  it('throws when name field is missing', () => {
    const content = `---
description: A test skill
---
Body`;
    expect(() => parseManifest(content)).toThrow('must contain a "name" field');
  });

  it('throws when description field is missing', () => {
    const content = `---
name: Test Skill
---
Body`;
    expect(() => parseManifest(content)).toThrow('must contain a "description" field');
  });

  it('allows empty body', () => {
    const content = `---
name: Test Skill
description: A test skill
---`;
    expect(parseManifest(content).body).toBe('');
  });

  it('ignores extra frontmatter fields', () => {
    const content = `---
name: Test Skill
description: A test skill
extra: field
another: value
---
Body`;
    const result = parseManifest(content);
    expect(result.name).toBe('Test Skill');
    expect(result.description).toBe('A test skill');
    expect(result.body).toBe('Body');
  });
});

describe('findManifestFile', () => {
  it('finds SKILL.md by exact name', () => {
    const files: SkillFile[] = [
      { path: 'SKILL.md', content: Buffer.from(''), size: 0 },
    ];
    expect(findManifestFile(files).path).toBe('SKILL.md');
  });

  it('finds case-insensitive variants', () => {
    expect(
      findManifestFile([{ path: 'skill.md', content: Buffer.from(''), size: 0 }]).path
    ).toBe('skill.md');
    expect(
      findManifestFile([{ path: 'Skill.md', content: Buffer.from(''), size: 0 }]).path
    ).toBe('Skill.md');
  });

  it('finds nested SKILL.md', () => {
    const files: SkillFile[] = [
      { path: 'src/SKILL.md', content: Buffer.from(''), size: 0 },
    ];
    expect(findManifestFile(files).path).toBe('src/SKILL.md');
  });

  it('throws when no SKILL.md found', () => {
    const files: SkillFile[] = [
      { path: 'README.md', content: Buffer.from(''), size: 0 },
    ];
    expect(() => findManifestFile(files)).toThrow('No SKILL.md manifest file found');
  });

  it('throws when multiple SKILL.md files found', () => {
    const files: SkillFile[] = [
      { path: 'SKILL.md', content: Buffer.from(''), size: 0 },
      { path: 'src/SKILL.md', content: Buffer.from(''), size: 0 },
    ];
    expect(() => findManifestFile(files)).toThrow('Multiple SKILL.md manifest files found');
  });
});

describe('validateBundle', () => {
  it('validates a bundle with SKILL.md and extra files', () => {
    const manifest = `---
name: Test Skill
description: A test skill
---
Body`;
    const files: SkillFile[] = [
      { path: 'SKILL.md', content: Buffer.from(manifest), size: manifest.length },
      { path: 'helper.py', content: Buffer.from('pass'), size: 4 },
    ];
    const result = validateBundle(files);
    expect(result.manifest.name).toBe('Test Skill');
    expect(result.manifestFile.path).toBe('SKILL.md');
  });

  it('throws when no SKILL.md in bundle', () => {
    const files: SkillFile[] = [
      { path: 'README.md', content: Buffer.from(''), size: 0 },
    ];
    expect(() => validateBundle(files)).toThrow();
  });
});
