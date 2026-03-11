import { Router, Request, Response } from 'express';
import multer from 'multer';
import { errorResponse, notFoundError } from '../utils';
import { skillsState } from './state';
import { validateBundle } from './manifest';
import {
  processMultipartFiles,
  processZipUpload,
  saveSkillVersion,
  deleteSkillStorage,
  guessContentType,
} from './storage';
import type {
  Skill,
  SkillFile,
  SkillVersion,
  SkillVersionFile,
  UpdateSkillRequest,
  PaginationParams,
} from './types';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

let storageDir = '';
export function setSkillStorageDir(dir: string): void {
  storageDir = dir;
}

function parsePaginationParams(query: Request['query']): PaginationParams {
  return {
    limit: query.limit ? Math.min(parseInt(query.limit as string, 10), 100) : 20,
    order: (query.order as 'asc' | 'desc') ?? 'desc',
    after: query.after as string | undefined,
    before: query.before as string | undefined,
  };
}

/**
 * Process uploaded multer files into SkillFile[], detecting zip vs multipart.
 */
async function extractSkillFiles(files: Express.Multer.File[]): Promise<SkillFile[]> {
  const firstFile = files[0];
  const isZip =
    firstFile.mimetype === 'application/zip' || firstFile.originalname.endsWith('.zip');

  if (isZip) {
    return processZipUpload(firstFile.buffer);
  }
  return processMultipartFiles(files);
}

function buildVersionFiles(files: SkillFile[]): SkillVersionFile[] {
  return files.map((f) => ({
    path: f.path,
    content_type: guessContentType(f.path),
    size: f.size,
  }));
}

// POST /v1/skills — create a new skill from file upload
router.post('/', upload.any(), async (req: Request, res: Response) => {
  try {
    const multerFiles = req.files as Express.Multer.File[] | undefined;
    if (!multerFiles || multerFiles.length === 0) {
      return res.status(400).json(errorResponse('No files provided'));
    }

    let skillFiles: SkillFile[];
    try {
      skillFiles = await extractSkillFiles(multerFiles);
    } catch (error) {
      return res.status(400).json(
        errorResponse(error instanceof Error ? error.message : 'Failed to process files')
      );
    }

    let manifest;
    try {
      const result = validateBundle(skillFiles);
      manifest = result.manifest;
    } catch (error) {
      return res.status(400).json(
        errorResponse(error instanceof Error ? error.message : 'Invalid skill bundle')
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const skillId = skillsState.generateSkillId();

    const version: SkillVersion = {
      version: 1,
      created_at: now,
      files: buildVersionFiles(skillFiles),
      manifest,
    };

    const skill: Skill = {
      id: skillId,
      object: 'skill',
      created_at: now,
      name: manifest.name,
      description: manifest.description,
      default_version: 1,
      latest_version: 1,
      versions: [version],
      metadata: {},
    };

    skillsState.createSkill(skill);
    saveSkillVersion(storageDir, skillId, 1, skillFiles);

    return res.status(201).json(skillsState.toSkillResponse(skill));
  } catch (error) {
    console.error('Error creating skill:', error);
    return res.status(500).json(
      errorResponse(error instanceof Error ? error.message : 'Internal server error')
    );
  }
});

// GET /v1/skills — list skills (paginated)
router.get('/', (req: Request, res: Response) => {
  const pagination = parsePaginationParams(req.query);
  return res.json(skillsState.listSkills(pagination));
});

// GET /v1/skills/:skill_id — retrieve a skill
router.get('/:skill_id', (req: Request, res: Response) => {
  const response = skillsState.getSkillResponse(req.params.skill_id);
  if (!response) {
    return res.status(404).json(notFoundError('skill'));
  }
  return res.json(response);
});

// POST /v1/skills/:skill_id — update a skill (default_version, metadata)
router.post('/:skill_id', (req: Request, res: Response) => {
  const { skill_id } = req.params;
  const body: UpdateSkillRequest = req.body;

  const skill = skillsState.getSkill(skill_id);
  if (!skill) {
    return res.status(404).json(notFoundError('skill'));
  }

  if (body.default_version !== undefined) {
    const versionExists = skill.versions.some((v) => v.version === body.default_version);
    if (!versionExists) {
      return res.status(400).json(
        errorResponse(`Version ${body.default_version} does not exist for this skill`)
      );
    }
  }

  const updated = skillsState.updateSkill(skill_id, body);
  if (!updated) {
    return res.status(404).json(notFoundError('skill'));
  }
  return res.json(skillsState.toSkillResponse(updated));
});

// DELETE /v1/skills/:skill_id — delete a skill
router.delete('/:skill_id', (req: Request, res: Response) => {
  const { skill_id } = req.params;
  const deleted = skillsState.deleteSkill(skill_id);

  if (deleted) {
    deleteSkillStorage(storageDir, skill_id);
  }

  return res.json({
    id: skill_id,
    object: 'skill.deleted',
    deleted,
  });
});

// POST /v1/skills/:skill_id/versions — upload a new version
router.post('/:skill_id/versions', upload.any(), async (req: Request, res: Response) => {
  try {
    const { skill_id } = req.params;
    const multerFiles = req.files as Express.Multer.File[] | undefined;

    if (!multerFiles || multerFiles.length === 0) {
      return res.status(400).json(errorResponse('No files provided'));
    }

    const skill = skillsState.getSkill(skill_id);
    if (!skill) {
      return res.status(404).json(notFoundError('skill'));
    }

    let skillFiles: SkillFile[];
    try {
      skillFiles = await extractSkillFiles(multerFiles);
    } catch (error) {
      return res.status(400).json(
        errorResponse(error instanceof Error ? error.message : 'Failed to process files')
      );
    }

    let manifest;
    try {
      const result = validateBundle(skillFiles);
      manifest = result.manifest;
    } catch (error) {
      return res.status(400).json(
        errorResponse(error instanceof Error ? error.message : 'Invalid skill bundle')
      );
    }

    const newVersionNum = skill.latest_version + 1;
    const now = Math.floor(Date.now() / 1000);

    const version: SkillVersion = {
      version: newVersionNum,
      created_at: now,
      files: buildVersionFiles(skillFiles),
      manifest,
    };

    skillsState.addVersion(skill_id, version);
    saveSkillVersion(storageDir, skill_id, newVersionNum, skillFiles);

    // Update skill name/description from new manifest
    const updated = skillsState.updateSkill(skill_id, {
      name: manifest.name,
      description: manifest.description,
    });

    if (!updated) {
      return res.status(404).json(notFoundError('skill'));
    }

    return res.status(201).json(skillsState.toSkillResponse(updated));
  } catch (error) {
    console.error('Error creating skill version:', error);
    return res.status(500).json(
      errorResponse(error instanceof Error ? error.message : 'Internal server error')
    );
  }
});

export default router;
