import fs from "node:fs/promises";
import path from "node:path";

import { ensurePrivateDirectory, hardenPrivateFile } from "../sessionDb/fileHardening";
import {
  createResearchFileSearchStore,
  deleteResearchFileSearchStore,
  uploadFileToResearchFileSearchStore,
} from "./researchRuntime";
import { MAX_RESEARCH_UPLOAD_BYTES, type ResearchInputFile } from "./types";

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
    try {
      const raw = await fs.readFile(path.join(this.uploadsDir(), `${fileId}.json`), "utf-8");
      const parsed = JSON.parse(raw) as { version?: number; file?: ResearchInputFile };
      if (parsed.version !== metadataVersion || !parsed.file) {
        return null;
      }
      return parsed.file;
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
    if (!fileSearchStoreName) {
      fileSearchStoreName = await createResearchFileSearchStore({
        apiKey: opts.apiKey,
        displayName: `Research ${opts.researchId}`,
      });
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

    await Promise.all(opts.files.map((file) => this.deletePendingUpload(file)));

    return {
      files: uploadedFiles,
      fileSearchStoreName,
    };
  }

  async deleteResearchStore(apiKey: string, fileSearchStoreName: string): Promise<void> {
    await deleteResearchFileSearchStore({ apiKey, fileSearchStoreName });
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
}
