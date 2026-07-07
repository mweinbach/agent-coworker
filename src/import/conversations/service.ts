import fs from "node:fs/promises";
import path from "node:path";

import { getKnownResolvedModelMetadata } from "../../models/metadata";
import {
  type JsonRpcWorkspaceSummary,
  listWorkspaceSummaries,
} from "../../server/jsonrpc/workspaceCatalog";
import type { SessionDb } from "../../server/sessionDb";
import type { WebDesktopServiceLike } from "../../server/webDesktopService";
import type { AgentConfig } from "../../types";
import { getConversationSourceAdapter } from "./adapters";
import { persistImportedConversation, selectImportModel } from "./persist";
import { countVisibleMessages } from "./snapshot";
import type {
  ConversationImportSource,
  ConversationPreviewItem,
  ConversationSourceCandidate,
  ConversationSourceRequest,
  ConversationSourceSelectionOptions,
  ConversationWorkspaceMappingInput,
  ConversationWorkspaceMappingsValidateResult,
  ExternalConversation,
} from "./types";
import {
  mapConversationWorkspace,
  resolveWorkspaceMappingInput,
  validateWorkspaceMappingInput,
} from "./workspaceMapping";

export type ConversationImportService = ReturnType<typeof createConversationImportService>;

export type ConversationImportPreviewResult = {
  conversations: ConversationPreviewItem[];
};

export type ConversationImportImportResult = {
  imported: Array<{
    source: ConversationImportSource;
    fingerprint: string;
    threadId: string;
    workspaceId: string | null;
    workspacePath: string;
    title: string;
  }>;
  skipped: Array<{
    source: ConversationImportSource;
    fingerprint: string;
    existingThreadId: string;
    reason: "already_imported";
  }>;
  failed: Array<{
    source: ConversationImportSource;
    fingerprint: string;
    message: string;
  }>;
  createdWorkspaces: Array<{
    workspaceId: string;
    path: string;
    name: string;
  }>;
};

type ServiceOptions = {
  sessionDb: SessionDb;
  homedir: string;
  getConfig: () => AgentConfig;
  desktopService?: WebDesktopServiceLike | null;
  onWorkspaceListChanged?: () => void;
};

function hashWorkspaceId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeSourceRequests(
  input?: ConversationSourceRequest[] | ConversationSourceSelectionOptions,
): ConversationSourceRequest[] {
  if (Array.isArray(input)) {
    return input.length > 0 ? input : [{ source: "codex" }, { source: "claude-code" }];
  }
  if (input?.sources && input.sources.length > 0) return input.sources;

  const explicitPaths = input?.explicitPaths?.filter((entry) => entry.trim()) ?? [];
  const hasIncludeFlag =
    input?.includeCodex !== undefined ||
    input?.includeClaudeCode !== undefined ||
    input?.includeCowork !== undefined;
  const sources: ConversationImportSource[] = hasIncludeFlag
    ? [
        ...(input?.includeCodex === true ? (["codex"] as const) : []),
        ...(input?.includeClaudeCode === true ? (["claude-code"] as const) : []),
        ...(input?.includeCowork === true ? (["cowork"] as const) : []),
      ]
    : ["codex", "claude-code"];

  if (explicitPaths.length === 0) return sources.map((source) => ({ source }));
  return sources.flatMap((source) => explicitPaths.map((path) => ({ source, path })));
}

function groupExplicitPathsBySource(
  requests: ConversationSourceRequest[],
): Map<ConversationImportSource, string[]> {
  const grouped = new Map<ConversationImportSource, string[]>();
  for (const request of requests) {
    if (!request.path) {
      if (!grouped.has(request.source)) grouped.set(request.source, []);
      continue;
    }
    const existing = grouped.get(request.source) ?? [];
    existing.push(request.path);
    grouped.set(request.source, existing);
  }
  return grouped;
}

function previewKey(source: ConversationImportSource, fingerprint: string): string {
  return `${source}:${fingerprint}`;
}

function existingWorkspace(
  workspaces: JsonRpcWorkspaceSummary[],
  workspacePath: string,
): JsonRpcWorkspaceSummary | null {
  const resolved = path.resolve(workspacePath);
  return workspaces.find((workspace) => path.resolve(workspace.path) === resolved) ?? null;
}

async function ensureDesktopWorkspaceForPath(input: {
  desktopService?: WebDesktopServiceLike | null;
  fallbackCwd: string;
  workspacePath: string;
  name?: string;
}): Promise<{ workspaceId: string | null; workspacePath: string; name: string; created: boolean }> {
  const workspacePath = await fs
    .realpath(input.workspacePath)
    .catch(() => path.resolve(input.workspacePath));
  const { workspaces } = await listWorkspaceSummaries({
    workingDirectory: input.fallbackCwd,
    desktopService: input.desktopService,
  });
  const existing = existingWorkspace(workspaces, workspacePath);
  if (existing) {
    return {
      workspaceId: existing.id,
      workspacePath: existing.path,
      name: existing.name,
      created: false,
    };
  }
  if (!input.desktopService) {
    return {
      workspaceId: null,
      workspacePath,
      name: input.name?.trim() || path.basename(workspacePath) || workspacePath,
      created: false,
    };
  }

  const now = new Date().toISOString();
  const id = `import-${hashWorkspaceId(workspacePath)}`;
  const name = input.name?.trim() || path.basename(workspacePath) || workspacePath;
  const state = await input.desktopService.loadState({ fallbackCwd: input.fallbackCwd });
  const already = state.workspaces.find(
    (workspace) => path.resolve(workspace.path) === path.resolve(workspacePath),
  );
  if (already) {
    return {
      workspaceId: already.id,
      workspacePath: already.path,
      name: already.name,
      created: false,
    };
  }
  await input.desktopService.saveState({
    ...state,
    workspaces: [
      ...state.workspaces,
      {
        id,
        name,
        path: workspacePath,
        workspaceKind: "project",
        createdAt: now,
        lastOpenedAt: now,
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
    ],
  });
  return { workspaceId: id, workspacePath, name, created: true };
}

function markUnsupportedOriginalModel(input: {
  conversation: ExternalConversation;
  homedir: string;
}): void {
  const provider = input.conversation.originalProvider;
  const model = input.conversation.originalModel;
  if (!provider || !model) return;
  const coworkProvider =
    provider === "openai" && input.conversation.source === "codex" ? "codex-cli" : provider;
  if (
    coworkProvider !== "google" &&
    coworkProvider !== "openai" &&
    coworkProvider !== "anthropic" &&
    coworkProvider !== "bedrock" &&
    coworkProvider !== "baseten" &&
    coworkProvider !== "together" &&
    coworkProvider !== "fireworks" &&
    coworkProvider !== "firepass" &&
    coworkProvider !== "nvidia" &&
    coworkProvider !== "lmstudio" &&
    coworkProvider !== "minimax" &&
    coworkProvider !== "opencode-go" &&
    coworkProvider !== "opencode-zen" &&
    coworkProvider !== "codex-cli" &&
    coworkProvider !== "antigravity"
  ) {
    input.conversation.warnings.push({
      code: "unsupported_model",
      message: `Original provider ${provider} is not a Cowork provider; the import will use the selected Cowork model.`,
    });
    return;
  }
  if (!getKnownResolvedModelMetadata(coworkProvider, model, { home: input.homedir })) {
    input.conversation.warnings.push({
      code: "unsupported_model",
      message: `Original model ${model} is not registered in Cowork; the import will use the selected Cowork model.`,
    });
  }
}

export function createConversationImportService(opts: ServiceOptions) {
  async function discoverSources(
    requests?: ConversationSourceRequest[] | ConversationSourceSelectionOptions,
  ): Promise<ConversationSourceCandidate[]> {
    const normalized = normalizeSourceRequests(requests);
    const grouped = groupExplicitPathsBySource(normalized);
    const candidates: ConversationSourceCandidate[] = [];
    for (const [source, explicitPaths] of grouped.entries()) {
      const adapter = getConversationSourceAdapter(source);
      const discovered = await adapter.discover({
        homedir: opts.homedir,
        explicitPaths: explicitPaths.length > 0 ? explicitPaths : undefined,
        currentCoworkDbPath: opts.sessionDb.dbPath,
      });
      candidates.push(...discovered);
    }
    return candidates;
  }

  async function loadConversations(
    input: ConversationSourceSelectionOptions & {
      limit?: number;
      includeArchived?: boolean;
    },
  ): Promise<ExternalConversation[]> {
    const candidates = await discoverSources(input);
    const conversations: ExternalConversation[] = [];
    for (const candidate of candidates) {
      if (!candidate.available) continue;
      const adapter = getConversationSourceAdapter(candidate.source);
      const parsed = await adapter.preview(candidate, {
        limit: input.limit,
        includeArchived: input.includeArchived,
        currentCoworkDbPath: opts.sessionDb.dbPath,
      });
      conversations.push(...parsed);
    }
    for (const conversation of conversations) {
      markUnsupportedOriginalModel({ conversation, homedir: opts.homedir });
    }
    return conversations;
  }

  async function preview(
    input: ConversationSourceSelectionOptions & {
      limit?: number;
      includeArchived?: boolean;
    },
  ): Promise<ConversationImportPreviewResult> {
    const config = opts.getConfig();
    const { workspaces } = await listWorkspaceSummaries({
      workingDirectory: config.workingDirectory,
      desktopService: opts.desktopService,
      homedir: opts.homedir,
    });
    const conversations = await loadConversations(input);
    const previews = await Promise.all(
      conversations.map(async (conversation): Promise<ConversationPreviewItem> => {
        const existing = opts.sessionDb.getExternalConversationImport(
          conversation.source,
          conversation.fingerprint,
        );
        return {
          source: conversation.source,
          sourceId: conversation.sourceId,
          sourcePath: conversation.sourcePath,
          fingerprint: conversation.fingerprint,
          title: conversation.title,
          cwd: conversation.cwd,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          originalProvider: conversation.originalProvider,
          originalModel: conversation.originalModel,
          messageCount: countVisibleMessages(conversation),
          toolCount: conversation.items.filter((item) => item.kind === "tool").length,
          warnings: conversation.warnings,
          mapping: await mapConversationWorkspace({ conversation, workspaces }),
          alreadyImportedThreadId: existing?.importedSessionId ?? null,
        };
      }),
    );
    return {
      conversations: previews.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  async function importSelected(
    input: ConversationSourceSelectionOptions & {
      selected: Array<{ source: ConversationImportSource; fingerprint: string }>;
      mappings?: Record<string, ConversationWorkspaceMappingInput>;
      provider?: AgentConfig["provider"];
      model?: string;
      defaultProvider?: AgentConfig["provider"];
      defaultModel?: string;
      mode?: "skip-existing";
      includeArchived?: boolean;
    },
  ): Promise<ConversationImportImportResult> {
    const config = opts.getConfig();
    const conversations = await loadConversations({
      sources: input.sources,
      includeArchived: input.includeArchived,
    });
    const byKey = new Map(
      conversations.map((conversation) => [
        previewKey(conversation.source, conversation.fingerprint),
        conversation,
      ]),
    );
    const { workspaces } = await listWorkspaceSummaries({
      workingDirectory: config.workingDirectory,
      desktopService: opts.desktopService,
      homedir: opts.homedir,
    });
    const result: ConversationImportImportResult = {
      imported: [],
      skipped: [],
      failed: [],
      createdWorkspaces: [],
    };
    const modelSelection = selectImportModel({
      requestedProvider: input.provider ?? input.defaultProvider,
      requestedModel: input.model ?? input.defaultModel,
      defaultProvider: config.provider,
      defaultModel: config.model,
    });

    for (const selected of input.selected) {
      const key = previewKey(selected.source, selected.fingerprint);
      const conversation = byKey.get(key);
      if (!conversation) {
        result.failed.push({
          ...selected,
          message: "Selected conversation was not found in the scanned sources.",
        });
        continue;
      }
      const existing = opts.sessionDb.getExternalConversationImport(
        conversation.source,
        conversation.fingerprint,
      );
      if (existing) {
        result.skipped.push({
          source: conversation.source,
          fingerprint: conversation.fingerprint,
          existingThreadId: existing.importedSessionId,
          reason: "already_imported",
        });
        continue;
      }

      const mappingInput = input.mappings?.[conversation.fingerprint] ?? input.mappings?.[key];
      let workspacePath: string;
      let workspaceId: string | null = null;
      if (mappingInput) {
        const resolved = resolveWorkspaceMappingInput({ mapping: mappingInput, workspaces });
        if ("error" in resolved) {
          result.failed.push({ ...selected, message: resolved.error });
          continue;
        }
        const ensured =
          mappingInput.kind === "create"
            ? await ensureDesktopWorkspaceForPath({
                desktopService: opts.desktopService,
                fallbackCwd: config.workingDirectory,
                workspacePath: resolved.workspacePath,
                name: resolved.name,
              })
            : {
                workspaceId: resolved.workspaceId,
                workspacePath: resolved.workspacePath,
                name: resolved.name ?? path.basename(resolved.workspacePath),
                created: false,
              };
        workspacePath = ensured.workspacePath;
        workspaceId = ensured.workspaceId;
        if (ensured.created && ensured.workspaceId) {
          result.createdWorkspaces.push({
            workspaceId: ensured.workspaceId,
            path: ensured.workspacePath,
            name: ensured.name,
          });
        }
      } else {
        const mapping = await mapConversationWorkspace({ conversation, workspaces });
        if (mapping.status === "missing") {
          result.failed.push({
            ...selected,
            message: "Conversation needs an explicit workspace mapping before import.",
          });
          continue;
        }
        if (mapping.status === "matched") {
          workspacePath = mapping.workspacePath;
          workspaceId = mapping.workspaceId;
        } else {
          const ensured = await ensureDesktopWorkspaceForPath({
            desktopService: opts.desktopService,
            fallbackCwd: config.workingDirectory,
            workspacePath: mapping.workspacePath,
            name: mapping.name,
          });
          workspacePath = ensured.workspacePath;
          workspaceId = ensured.workspaceId;
          if (ensured.created && ensured.workspaceId) {
            result.createdWorkspaces.push({
              workspaceId: ensured.workspaceId,
              path: ensured.workspacePath,
              name: ensured.name,
            });
          }
        }
      }

      try {
        const persisted = await persistImportedConversation({
          sessionDb: opts.sessionDb,
          importInput: {
            conversation,
            workspacePath,
            provider: modelSelection.provider,
            model: modelSelection.model,
            enableMcp: config.enableMcp ?? true,
            ...(config.outputDirectory ? { outputDirectory: config.outputDirectory } : {}),
            ...(config.uploadsDirectory ? { uploadsDirectory: config.uploadsDirectory } : {}),
          },
        });
        result.imported.push({
          source: conversation.source,
          fingerprint: conversation.fingerprint,
          threadId: persisted.threadId,
          workspaceId,
          workspacePath,
          title: conversation.title,
        });
      } catch (error) {
        result.failed.push({
          source: conversation.source,
          fingerprint: conversation.fingerprint,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (result.createdWorkspaces.length > 0) {
      opts.onWorkspaceListChanged?.();
    }
    return result;
  }

  async function validateWorkspaceMappings(input: {
    mappings: Record<string, ConversationWorkspaceMappingInput>;
  }): Promise<ConversationWorkspaceMappingsValidateResult> {
    const config = opts.getConfig();
    const { workspaces } = await listWorkspaceSummaries({
      workingDirectory: config.workingDirectory,
      desktopService: opts.desktopService,
      homedir: opts.homedir,
    });
    const result: ConversationWorkspaceMappingsValidateResult = {
      valid: true,
      mappings: {},
      errors: [],
    };
    for (const [fingerprint, mapping] of Object.entries(input.mappings)) {
      const validation = await validateWorkspaceMappingInput({ mapping, workspaces });
      if ("error" in validation) {
        result.valid = false;
        result.errors.push({ fingerprint, message: validation.error });
        continue;
      }
      if (validation.status === "missing") {
        result.valid = false;
        result.errors.push({ fingerprint, message: "Workspace path does not exist." });
      }
      result.mappings[fingerprint] = validation;
    }
    return result;
  }

  return {
    discoverSources,
    preview,
    importSelected,
    validateWorkspaceMappings,
  };
}
