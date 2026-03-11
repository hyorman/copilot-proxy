import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SkillFile } from './types';

/**
 * Process multipart files from multer into SkillFile array
 */
export function processMultipartFiles(files: Express.Multer.File[]): SkillFile[] {
  return files.map(file => ({
    path: file.originalname,
    content: file.buffer,
    size: file.size,
  }));
}

/**
 * Parse zip buffer and extract files
 * Implements minimal zip format reader using Node.js built-ins
 */
export async function processZipUpload(zipBuffer: Buffer): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  // Find End of Central Directory record (EOCD)
  // EOCD signature: 0x06054b50, located at end of file
  const endPos = zipBuffer.length;
  let eocdOffset = -1;

  const searchStart = Math.max(0, endPos - 0xffff - 22);
  for (let i = endPos - 22; i >= searchStart; i--) {
    if (
      zipBuffer[i] === 0x50 &&
      zipBuffer[i + 1] === 0x4b &&
      zipBuffer[i + 2] === 0x05 &&
      zipBuffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip file: End of Central Directory record not found');
  }

  // Parse EOCD
  const diskNumber = zipBuffer.readUInt16LE(eocdOffset + 4);
  const centralDirDisk = zipBuffer.readUInt16LE(eocdOffset + 6);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirDisk !== 0) {
    throw new Error('Invalid zip file: multi-disk archives not supported');
  }

  // Parse central directory entries
  let currentOffset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (currentOffset + 46 > zipBuffer.length) {
      throw new Error('Invalid zip file: corrupted central directory');
    }

    const signature = zipBuffer.readUInt32LE(currentOffset);
    if (signature !== 0x02014b50) {
      throw new Error('Invalid zip file: central directory entry signature mismatch');
    }

    const compressionMethod = zipBuffer.readUInt16LE(currentOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(currentOffset + 20);
    const filenameLength = zipBuffer.readUInt16LE(currentOffset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(currentOffset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(currentOffset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(currentOffset + 42);

    // Read filename
    const filename = zipBuffer
      .slice(currentOffset + 46, currentOffset + 46 + filenameLength)
      .toString('utf-8');

    // Skip directory entries
    if (!filename.endsWith('/')) {
      // Read local file header to get actual file data offset
      if (localHeaderOffset + 30 > zipBuffer.length) {
        throw new Error('Invalid zip file: corrupted local file header');
      }

      const localHeaderSig = zipBuffer.readUInt32LE(localHeaderOffset);
      if (localHeaderSig !== 0x04034b50) {
        throw new Error('Invalid zip file: local file header signature mismatch');
      }

      const localFilenameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);

      const fileDataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraFieldLength;
      const fileDataEnd = fileDataOffset + compressedSize;

      if (fileDataEnd > zipBuffer.length) {
        throw new Error('Invalid zip file: file data extends beyond archive');
      }

      let fileContent: Buffer;
      const compressedData = zipBuffer.slice(fileDataOffset, fileDataEnd);

      if (compressionMethod === 0) {
        // Stored (no compression)
        fileContent = compressedData;
      } else if (compressionMethod === 8) {
        // Deflated
        try {
          fileContent = zlib.inflateRawSync(compressedData);
        } catch (error) {
          throw new Error(`Failed to decompress file '${filename}': ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        throw new Error(`Unsupported compression method ${compressionMethod} for file '${filename}'`);
      }

      files.push({
        path: filename,
        content: fileContent,
        size: fileContent.length,
      });
    }

    // Move to next central directory entry
    currentOffset += 46 + filenameLength + extraFieldLength + fileCommentLength;
  }

  return files;
}

/**
 * Get the skill storage directory
 */
export function getSkillStorageDir(extensionPath: string): string {
  const storageDir = path.join(extensionPath, 'skill-bundles');
  fs.mkdirSync(storageDir, { recursive: true });
  return storageDir;
}

/**
 * Save a skill version to disk
 */
export function saveSkillVersion(
  storageDir: string,
  skillId: string,
  version: number,
  files: SkillFile[]
): void {
  const baseDir = path.resolve(storageDir, skillId, `v${version}`);
  for (const file of files) {
    // Validate file path to prevent path traversal (zip-slip)
    const filePath = path.resolve(baseDir, file.path);
    if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
      throw new Error(`Invalid file path: ${file.path}`);
    }
    const fileDir = path.dirname(filePath);
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }
}

/**
 * Delete a specific skill version
 */
export function deleteSkillVersion(
  storageDir: string,
  skillId: string,
  version: number
): void {
  const versionDir = path.join(storageDir, skillId, `v${version}`);
  fs.rmSync(versionDir, { recursive: true, force: true });
}

/**
 * Delete all versions of a skill
 */
export function deleteSkillStorage(storageDir: string, skillId: string): void {
  const skillDir = path.join(storageDir, skillId);
  fs.rmSync(skillDir, { recursive: true, force: true });
}

/**
 * Guess MIME type based on file extension
 */
export function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.md': 'text/markdown',
    '.py': 'text/x-python',
    '.js': 'application/javascript',
    '.ts': 'text/typescript',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.zip': 'application/zip',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.sh': 'application/x-sh',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
