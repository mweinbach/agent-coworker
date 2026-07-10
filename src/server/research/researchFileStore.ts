import fs from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDirectory, hardenPrivateFile } from "../sessionDb/fileHardening";
import {
  createResearchFileSearchStore,
  deleteResearchFileSearchStore,
  uploadFileToResearchFileSearchStore,
} from "./researchRuntime";
import {
  MAX_RESEARCH_UPLOAD_BYTES,
  RESEARCH_UPLOAD_ID_PATTERN,
  type ResearchInputFile,
  researchInputFileSchema,
} from "./types";

type ResearchFileStoreOptions = {
  rootDir: string;
};

const metadataVersion = 1;

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).trim();
  const normalized = base
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "upload.bin";
}

function estimateBase64DecodedBytes(contentBase64: string): number {
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  return Math.floor((contentBase64.length * 3) / 4) - padding;
}

function isPathInside(parentDir: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  );
}

export class ResearchFileStore {
  private readonly rootDir: string;

  constructor(opts: ResearchFileStoreOptions) {
    this.rootDir = path.join(opts.rootDir, "research");
  }

  uploadsDir(): string {
    return path.join(this.rootDir, "uploads");
  }

  researchDir(researchId: string): string {
    return path.join(this.rootDir, researchId);
  }

  exportPath(researchId: string, filename: string): string {
    return path.join(this.researchDir(researchId), filename);
  }

  async savePendingUpload(opts: {
    filename: string;
    contentBase64: string;
    mimeType: string;
  }): Promise<ResearchInputFile> {
    const fileId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(opts.filename);
    const uploadedAt = new Date().toISOString();
    if (estimateBase64DecodedBytes(opts.contentBase64) > MAX_RESEARCH_UPLOAD_BYTES) {
      throw new Error(`Research uploads are limited to ${MAX_RESEARCH_UPLOAD_BYTES} bytes.`);
    }
    const decoded = Buffer.from(opts.contentBase64, "base64");
    if (decoded.byteLength > MAX_RESEARCH_UPLOAD_BYTES) {
      throw new Error(`Research uploads are limited to ${MAX_RESEARCH_UPLOAD_BYTES} bytes.`);
    }
    const uploadsDir = this.uploadsDir();
    await ensurePrivateDirectory(uploadsDir);
    const filePath = path.join(uploadsDir, `${fileId}-${safeFilename}`);
    await fs.writeFile(filePath, decoded);
    await hardenPrivateFile(filePath);

    const record: ResearchInputFile = {
      fileId,
      filename: safeFilename,
      mimeType: opts.mimeType,
      path: filePath,
      uploadedAt,
    };

    const metadataPath = path.join(uploadsDir, `${fileId}.json`);
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify({ version: metadataVersion, file: record }, null, 2)}\n`,
      "utf-8",
    );
    await hardenPrivateFile(metadataPath);

    return record;
  }

  async readPendingUpload(fileId: string): Promise<ResearchInputFile | null> {
    // Only accept the generated UUID form so a caller-controlled id can never
    // traverse out of the uploads directory when joined into the metadata path.
    if (!RESEARCH_UPLOAD_ID_PATTERN.test(fileId)) {
      return null;
    }
    const uploadsDir = this.uploadsDir();
    const metadataPath = path.join(uploadsDir, `${fileId}.json`);
    // Defense in depth: the metadata file must canonicalize inside the uploads dir.
    if (!isPathInside(uploadsDir, metadataPath)) {
      return null;
    }
    try {
      const raw = await fs.readFile(metadataPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; file?: unknown };
      if (parsed.version !== metadataVersion) {
        return null;
      }
      // Validate the parsed metadata shape before trusting any of its fields.
      const result = researchInputFileSchema.safeParse(parsed.file);
      if (!result.success) {
        return null;
      }
      const file = result.data;
      // The recorded id must match the request, and the recorded local path must
      // itself live inside the uploads directory, so spoofed metadata cannot
      // redirect the later copy/upload to an arbitrary readable local file.
      if (file.fileId !== fileId || !isPathInside(uploadsDir, file.path)) {
        return null;
      }
      return file;
    } catch {
      return null;
    }
  }

  async prepareResearchFiles(opts: {
    apiKey: string;
    researchId: string;
    files: ResearchInputFile[];
    currentStoreName?: string | null;
  }): Promise<{ files: ResearchInputFile[]; fileSearchStoreName?: string }> {
    if (opts.files.length === 0) {
      return { files: [] };
    }

    const researchDir = this.researchDir(opts.researchId);
    const researchFilesDir = path.join(researchDir, "files");
    await ensurePrivateDirectory(researchDir);
    await ensurePrivateDirectory(researchFilesDir);

    const promotedFiles: ResearchInputFile[] = [];
    for (const file of opts.files) {
      const safeFilename = sanitizeFilename(file.filename);
      const destinationPath = path.join(researchFilesDir, `${file.fileId}-${safeFilename}`);
      if (destinationPath !== file.path) {
        await fs.copyFile(file.path, destinationPath);
        await hardenPrivateFile(destinationPath);
      }
      promotedFiles.push({
        ...file,
        filename: safeFilename,
        path: destinationPath,
      });
    }

    let fileSearchStoreName = opts.currentStoreName ?? undefined;
    let createdStoreName: string | null = null;
    try {
      if (!fileSearchStoreName) {
        fileSearchStoreName = await createResearchFileSearchStore({
          apiKey: opts.apiKey,
          displayName: `Research ${opts.researchId}`,
        });
        createdStoreName = fileSearchStoreName;
      }

      const uploadedFiles: ResearchInputFile[] = [];
      for (const file of promotedFiles) {
        if (file.documentName) {
          uploadedFiles.push(file);
          continue;
        }

        const uploaded = await uploadFileToResearchFileSearchStore({
          apiKey: opts.apiKey,
          fileSearchStoreName,
          filePath: file.path,
          mimeType: file.mimeType,
          displayName: file.filename,
        });
        uploadedFiles.push({
          ...file,
          ...(uploaded.documentName ? { documentName: uploaded.documentName } : {}),
        });
      }

      await this.deletePendingUploads(opts.files);

      return {
        files: uploadedFiles,
        fileSearchStoreName,
      };
    } catch (error) {
      if (createdStoreName) {
        try {
          await deleteResearchFileSearchStore({
            apiKey: opts.apiKey,
            fileSearchStoreName: createdStoreName,
          });
        } catch {
          // Best effort rollback; preserve the original upload failure.
        }
      }
      throw error;
    }
  }

  async deleteResearchStore(apiKey: string, fileSearchStoreName: string): Promise<void> {
    await deleteResearchFileSearchStore({ apiKey, fileSearchStoreName });
  }

  async deletePendingUploads(files: ResearchInputFile[]): Promise<void> {
    await Promise.all(files.map((file) => this.deletePendingUpload(file)));
  }

  async deletePendingUploadsByIds(fileIds: string[]): Promise<void> {
    await Promise.all(fileIds.map((fileId) => this.deletePendingUploadById(fileId)));
  }

  private async deletePendingUpload(file: ResearchInputFile): Promise<void> {
    const uploadsDir = this.uploadsDir();
    const resolvedUploadsDir = path.resolve(uploadsDir);
    const resolvedFilePath = path.resolve(file.path);
    if (!resolvedFilePath.startsWith(`${resolvedUploadsDir}${path.sep}`)) {
      return;
    }

    await Promise.all([
      fs.rm(path.join(uploadsDir, `${file.fileId}.json`), { force: true }),
      fs.rm(file.path, { force: true }),
    ]);
  }

  private async deletePendingUploadById(fileId: string): Promise<void> {
    const uploadsDir = this.uploadsDir();
    try {
      const entries = await fs.readdir(uploadsDir);
      const matches = entries
        .filter((entry) => entry === `${fileId}.json` || entry.startsWith(`${fileId}-`))
        .map((entry) => fs.rm(path.join(uploadsDir, entry), { force: true }));
      await Promise.all(matches);
    } catch {
      // Missing uploads directories or files are already effectively deleted.
    }
  }
}
