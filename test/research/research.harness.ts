import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import { exportResearch } from "../../src/server/research/export";
import { type ResearchRecord, researchRecordSchema } from "../../src/server/research/types";
import { SessionDb } from "../../src/server/sessionDb";

type RuntimeEvent = Record<string, unknown>;

export const researchRuntimeImpls = {
  createResearchInteractionStream: async (_opts?: unknown): Promise<AsyncIterable<RuntimeEvent>> =>
    emptyStream(),
  resumeResearchInteractionStream: async (_opts?: unknown): Promise<AsyncIterable<RuntimeEvent>> =>
    emptyStream(),
  createResearchFileSearchStore: async (_opts?: unknown) => "file-search-stores/mock-store",
  uploadFileToResearchFileSearchStore: async (_opts?: unknown) => ({
    documentName: "documents/mock-doc",
  }),
  deleteResearchFileSearchStore: async (_opts?: unknown) => {},
};

const createResearchInteractionStreamMock = mock(
  async (opts: unknown) => await researchRuntimeImpls.createResearchInteractionStream(opts),
);
const resumeResearchInteractionStreamMock = mock(
  async (opts: unknown) => await researchRuntimeImpls.resumeResearchInteractionStream(opts),
);
const cancelResearchInteractionMock = mock(async () => {});
const createResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await researchRuntimeImpls.createResearchFileSearchStore(opts),
);
const uploadFileToResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await researchRuntimeImpls.uploadFileToResearchFileSearchStore(opts),
);
const deleteResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await researchRuntimeImpls.deleteResearchFileSearchStore(opts),
);

mock.module("../../src/server/research/researchRuntime", () => ({
  createResearchInteractionStream: createResearchInteractionStreamMock,
  resumeResearchInteractionStream: resumeResearchInteractionStreamMock,
  cancelResearchInteraction: cancelResearchInteractionMock,
  createResearchFileSearchStore: createResearchFileSearchStoreMock,
  uploadFileToResearchFileSearchStore: uploadFileToResearchFileSearchStoreMock,
  deleteResearchFileSearchStore: deleteResearchFileSearchStoreMock,
}));

const { ResearchService } = await import("../../src/server/research/ResearchService");
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function emptyStream(): AsyncIterable<RuntimeEvent> {
  return (async function* () {})();
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeTmpCoworkHome(prefix = "research-test-"): Promise<{
  home: string;
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { home, rootDir, sessionsDir };
}

function makeResearchRecord(overrides: Partial<ResearchRecord> = {}): ResearchRecord {
  return researchRecordSchema.parse({
    id: "research-1",
    parentResearchId: null,
    title: "Research title",
    prompt: "Investigate the new benchmark results",
    status: "running",
    interactionId: "interaction-1",
    lastEventId: "evt-0",
    inputs: {
      files: [],
    },
    settings: {
      planApproval: false,
    },
    outputsMarkdown: "",
    thoughtSummaries: [],
    sources: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    error: null,
    ...overrides,
  });
}

async function waitFor<T>(
  getter: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = getter();
    if (predicate(value)) {
      return value;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

function installFetchStub(handler: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
}

function restoreFetchStub(): void {
  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  }
}

export function registerResearchServiceHooks() {
  beforeEach(() => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    researchRuntimeImpls.createResearchInteractionStream = async () => emptyStream();
    researchRuntimeImpls.resumeResearchInteractionStream = async () => emptyStream();
    researchRuntimeImpls.createResearchFileSearchStore = async () =>
      "file-search-stores/mock-store";
    researchRuntimeImpls.uploadFileToResearchFileSearchStore = async () => ({
      documentName: "documents/mock-doc",
    });
    researchRuntimeImpls.deleteResearchFileSearchStore = async () => {};
    createResearchInteractionStreamMock.mockClear();
    resumeResearchInteractionStreamMock.mockClear();
    cancelResearchInteractionMock.mockClear();
    createResearchFileSearchStoreMock.mockClear();
    uploadFileToResearchFileSearchStoreMock.mockClear();
    deleteResearchFileSearchStoreMock.mockClear();
  });

  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    citationMetadataInternal.clearCitationResolutionCache();
    restoreFetchStub();
  });
}

export {
  cancelResearchInteractionMock,
  createResearchFileSearchStoreMock,
  createResearchInteractionStreamMock,
  deferred,
  deleteResearchFileSearchStoreMock,
  emptyStream,
  installFetchStub,
  makeResearchRecord,
  makeTmpCoworkHome,
  ResearchService,
  restoreFetchStub,
  resumeResearchInteractionStreamMock,
  uploadFileToResearchFileSearchStoreMock,
  waitFor,
};
