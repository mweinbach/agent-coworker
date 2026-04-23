import path from "node:path";

import type { Interactions } from "@google/genai";

import { getSavedProviderApiKey } from "../../config";
import type { AgentConfig } from "../../types";
import { enrichCitationAnnotations } from "../citationMetadata";
import type { SessionDb } from "../sessionDb";
import type { StartServerSocket } from "../startServer/types";
import { buildInteractionToolsFromSettings } from "./settings";
import {
  cancelResearchInteraction,
  createResearchInteractionStream,
  resumeResearchInteractionStream,
  type ResearchInteractionStreamEvent,
} from "./researchRuntime";
import { ResearchFileStore } from "./researchFileStore";
import {
  normalizeResearchSettings,
  researchInputFileSchema,
  researchRecordSchema,
  type ResearchInputFile,
  type ResearchRecord,
  type ResearchSettings,
  type ResearchSource,
  type ResearchStatus,
  type ResearchThoughtSummary,
} from "./types";

type BufferedResearchNotification = {
  method: string;
  params: unknown;
  eventId: string | null;
};

type ResearchRuntimeState = {
  record: ResearchRecord;
  subscribers: Map<string, StartServerSocket>;
  ringBuffer: BufferedResearchNotification[];
  persistTimer: ReturnType<typeof setTimeout> | null;
  streamPromise: Promise<void> | null;
  cancelRequested: boolean;
  planExecutionMode: boolean;
};

type ResearchServiceOptions = {
  rootDir: string;
  sessionDb: SessionDb;
  getConfig: () => AgentConfig;
  sendJsonRpc: (ws: StartServerSocket, payload: unknown) => void;
  maxBufferedEvents?: number;
};

type StartResearchParams = {
  input: string;
  title?: string;
  settings?: unknown;
  attachedFileIds?: string[];
  attachedFiles?: ResearchInputFile[];
};

type FollowUpResearchParams = StartResearchParams;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sourceHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function buildResearchTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const fallback = firstLine ?? "Untitled research";
  return fallback.length > 80 ? `${fallback.slice(0, 77)}...` : fallback;
}

function extractTitleFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^[ \t]*#\s+(.+?)\s*$/m);
  if (!match) {
    return null;
  }
  let heading = match[1]
    .replace(/^[#]+\s*/, "")
    .replace(/^(?:chapter\s+)?\d+[.)]\s*[:–-]?\s*/i, "")
    .replace(/^(?:section\s+)?\d+(?:\.\d+)*\s*[:.–-]?\s*/i, "")
    .trim();
  if (heading.length === 0) {
    return null;
  }
  if (heading.length > 80) {
    heading = `${heading.slice(0, 77)}...`;
  }
  return heading;
}

function normalizeInteractionStatus(
  status: Interactions.Interaction["status"] | Interactions.InteractionStatusUpdate["status"] | undefined,
): ResearchStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "incomplete":
      return "failed";
    default:
      return "running";
  }
}

function isInteractionStartEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.InteractionStartEvent {
  return event.event_type === "interaction.start";
}

function isInteractionStatusUpdateEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.InteractionStatusUpdate {
  return event.event_type === "interaction.status_update";
}

function isInteractionCompleteEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.InteractionCompleteEvent {
  return event.event_type === "interaction.complete";
}

function isContentStartEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.ContentStart {
  return event.event_type === "content.start";
}

function isContentDeltaEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.ContentDelta {
  return event.event_type === "content.delta";
}

function isErrorEvent(
  event: ResearchInteractionStreamEvent,
): event is Interactions.ErrorEvent {
  return event.event_type === "error";
}

export class ResearchService {
  private readonly sessionDb: SessionDb;
  private readonly getConfigImpl: () => AgentConfig;
  private readonly sendJsonRpc: (ws: StartServerSocket, payload: unknown) => void;
  private readonly fileStore: ResearchFileStore;
  private readonly maxBufferedEvents: number;
  private readonly states = new Map<string, ResearchRuntimeState>();
  private initPromise: Promise<void> | null = null;

  constructor(opts: ResearchServiceOptions) {
    this.sessionDb = opts.sessionDb;
    this.getConfigImpl = opts.getConfig;
    this.sendJsonRpc = opts.sendJsonRpc;
    this.fileStore = new ResearchFileStore({ rootDir: opts.rootDir });
    this.maxBufferedEvents = opts.maxBufferedEvents ?? 500;
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.resumeInFlight();
    await this.initPromise;
  }

  async list(): Promise<ResearchRecord[]> {
    await this.init();
    const persisted = this.sessionDb.listResearch();
    const byId = new Map(persisted.map((record) => [record.id, record]));
    for (const [id, state] of this.states) {
      byId.set(id, state.record);
    }
    return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<ResearchRecord | null> {
    await this.init();
    const activeState = this.states.get(id);
    if (activeState) {
      activeState.record = await this.resolveStoredSourceDestinations(activeState.record);
      return activeState.record;
    }
    const record = this.sessionDb.getResearch(id);
    return record ? await this.resolveStoredSourceDestinations(record) : null;
  }

  async start(params: StartResearchParams): Promise<ResearchRecord> {
    await this.init();
    const input = params.input.trim();
    if (!input) {
      throw new Error("Research input is required.");
    }

    const now = new Date().toISOString();
    const record = researchRecordSchema.parse({
      id: crypto.randomUUID(),
      parentResearchId: null,
      title: params.title?.trim() || buildResearchTitle(input),
      prompt: input,
      status: "pending",
      interactionId: null,
      lastEventId: null,
      inputs: {
        files: [],
      },
      settings: normalizeResearchSettings(params.settings),
      outputsMarkdown: "",
      thoughtSummaries: [],
      sources: [],
      createdAt: now,
      updatedAt: now,
      error: null,
    });

    await this.sessionDb.upsertResearch(record);
    const state = this.getOrCreateState(record);
    this.broadcast(
      state,
      "research/updated",
      {
        research: state.record,
      },
      null,
    );

    const attachedFiles = await this.resolveAttachedFiles(params);
    state.streamPromise = this.executeResearch(state, {
      prompt: record.prompt,
      previousInteractionId: undefined,
      attachedFiles,
      collaborativePlanning: record.settings.planApproval,
    });

    return state.record;
  }

  async followUp(parentResearchId: string, params: FollowUpResearchParams): Promise<ResearchRecord> {
    await this.init();
    const parent = await this.get(parentResearchId);
    if (!parent) {
      throw new Error(`Unknown research id: ${parentResearchId}`);
    }
    if (!parent.interactionId) {
      throw new Error("The selected research has not started yet.");
    }
    const input = params.input.trim();
    if (!input) {
      throw new Error("Follow-up input is required.");
    }

    const now = new Date().toISOString();
    const record = researchRecordSchema.parse({
      id: crypto.randomUUID(),
      parentResearchId,
      title: params.title?.trim() || buildResearchTitle(input),
      prompt: input,
      status: "pending",
      interactionId: null,
      lastEventId: null,
      inputs: {
        files: [],
      },
      settings: normalizeResearchSettings(params.settings ?? parent.settings),
      outputsMarkdown: "",
      thoughtSummaries: [],
      sources: [],
      createdAt: now,
      updatedAt: now,
      error: null,
    });

    await this.sessionDb.upsertResearch(record);
    const state = this.getOrCreateState(record);
    this.broadcast(
      state,
      "research/updated",
      {
        research: state.record,
      },
      null,
    );

    const attachedFiles = await this.resolveAttachedFiles(params);
    state.streamPromise = this.executeResearch(state, {
      prompt: input,
      previousInteractionId: parent.interactionId,
      attachedFiles,
    });

    return state.record;
  }

  async rename(id: string, title: string): Promise<ResearchRecord | null> {
    await this.init();
    const existing = await this.get(id);
    if (!existing) {
      return null;
    }
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Title cannot be empty.");
    }
    const capped = trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
    const state = this.getOrCreateState(existing);
    this.updateRecord(state, {
      title: capped,
      updatedAt: new Date().toISOString(),
    });
    await this.flushPersistNow(state);
    this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);
    return state.record;
  }

  async cancel(id: string): Promise<ResearchRecord | null> {
    await this.init();
    const existing = await this.get(id);
    if (!existing) {
      return null;
    }

    const state = this.getOrCreateState(existing);
    state.cancelRequested = true;
    const apiKey = this.resolveGoogleApiKey();

    if (state.record.interactionId) {
      try {
        await cancelResearchInteraction({
          apiKey,
          interactionId: state.record.interactionId,
        });
      } catch {
        // Best effort; we still move local state to cancelled below.
      }
    }

    this.updateRecord(state, {
      status: "cancelled",
      error: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    await this.flushPersistNow(state);
    this.broadcast(
      state,
      "research/updated",
      { research: state.record },
      state.record.lastEventId,
    );
    this.broadcast(
      state,
      "research/failed",
      { researchId: state.record.id, status: state.record.status, error: state.record.error ?? "cancelled" },
      state.record.lastEventId,
    );
    return state.record;
  }

  async approvePlan(researchId: string): Promise<ResearchRecord | null> {
    await this.init();
    const existing = await this.get(researchId);
    if (!existing) {
      return null;
    }
    if (!existing.planPending || !existing.interactionId) {
      return null;
    }

    const state = this.getOrCreateState(existing);
    this.updateRecord(state, {
      planPending: false,
      status: "pending",
      outputsMarkdown: "",
      thoughtSummaries: [],
      sources: [],
      updatedAt: new Date().toISOString(),
    });
    await this.flushPersistNow(state);
    this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);

    state.streamPromise = this.executeResearch(state, {
      prompt: "Plan looks good!",
      previousInteractionId: state.record.interactionId ?? undefined,
      attachedFiles: [],
      collaborativePlanning: false,
    });

    return state.record;
  }

  async refinePlan(researchId: string, input: string): Promise<ResearchRecord | null> {
    await this.init();
    const existing = await this.get(researchId);
    if (!existing) {
      return null;
    }
    if (!existing.planPending || !existing.interactionId) {
      return null;
    }
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Refinement input is required.");
    }

    const state = this.getOrCreateState(existing);
    this.updateRecord(state, {
      planPending: false,
      status: "pending",
      outputsMarkdown: "",
      thoughtSummaries: [],
      sources: [],
      updatedAt: new Date().toISOString(),
    });
    await this.flushPersistNow(state);
    this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);

    state.streamPromise = this.executeResearch(state, {
      prompt: trimmed,
      previousInteractionId: state.record.interactionId ?? undefined,
      attachedFiles: [],
      collaborativePlanning: true,
    });

    return state.record;
  }

  async attachUploadedFile(researchId: string, fileId: string): Promise<ResearchRecord | null> {
    await this.init();
    const existing = await this.get(researchId);
    if (!existing) {
      return null;
    }
    const file = await this.fileStore.readPendingUpload(fileId);
    if (!file) {
      throw new Error(`Unknown uploaded research file: ${fileId}`);
    }
    const state = this.getOrCreateState(existing);
    const nextFiles = state.record.inputs.files.some((entry) => entry.fileId === file.fileId)
      ? state.record.inputs.files
      : [...state.record.inputs.files, file];
    this.updateRecord(state, {
      inputs: {
        ...state.record.inputs,
        files: nextFiles,
      },
      updatedAt: new Date().toISOString(),
    });
    await this.flushPersistNow(state);
    this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);
    return state.record;
  }

  async uploadFile(opts: {
    filename: string;
    contentBase64: string;
    mimeType: string;
  }): Promise<ResearchInputFile> {
    await this.init();
    return await this.fileStore.savePendingUpload(opts);
  }

  async subscribe(
    ws: StartServerSocket,
    researchId: string,
    afterEventId?: string,
  ): Promise<ResearchRecord | null> {
    await this.init();
    const record = await this.get(researchId);
    if (!record) {
      return null;
    }
    const state = this.getOrCreateState(record);
    const subscriberId = ws.data.connectionId ?? crypto.randomUUID();
    state.subscribers.set(subscriberId, ws);
    this.replayBufferedNotifications(state, ws, afterEventId);
    return state.record;
  }

  unsubscribe(ws: StartServerSocket, researchId: string): void {
    const subscriberId = ws.data.connectionId ?? "";
    if (!subscriberId) {
      return;
    }
    this.states.get(researchId)?.subscribers.delete(subscriberId);
  }

  unsubscribeAll(ws: StartServerSocket): void {
    const subscriberId = ws.data.connectionId ?? "";
    if (!subscriberId) {
      return;
    }
    for (const state of this.states.values()) {
      state.subscribers.delete(subscriberId);
    }
  }

  exportPathFor(researchId: string, filename: string): string {
    return this.fileStore.exportPath(researchId, filename);
  }

  private async executeResearch(
    state: ResearchRuntimeState,
    opts: {
      prompt: string;
      previousInteractionId?: string;
      attachedFiles: ResearchInputFile[];
      collaborativePlanning?: boolean;
    },
  ): Promise<void> {
    try {
      state.planExecutionMode = opts.collaborativePlanning ?? false;
      const apiKey = this.resolveGoogleApiKey();
      if (opts.attachedFiles.length > 0) {
        const prepared = await this.fileStore.prepareResearchFiles({
          apiKey,
          researchId: state.record.id,
          files: opts.attachedFiles,
          currentStoreName: state.record.inputs.fileSearchStoreName ?? null,
        });
        this.updateRecord(state, {
          inputs: {
            fileSearchStoreName: prepared.fileSearchStoreName,
            files: prepared.files,
          },
          updatedAt: new Date().toISOString(),
        });
        await this.flushPersistNow(state);
        this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);
      }

      this.updateRecord(state, {
        status: "running",
        error: null,
        updatedAt: new Date().toISOString(),
      });
      await this.flushPersistNow(state);
      this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);

      const tools = buildInteractionToolsFromSettings(
        state.record.settings,
        state.record.inputs.fileSearchStoreName,
      );
      const stream = await createResearchInteractionStream({
        apiKey,
        input: opts.prompt,
        ...(opts.previousInteractionId ? { previousInteractionId: opts.previousInteractionId } : {}),
        tools,
        collaborativePlanning: opts.collaborativePlanning,
      });
      await this.consumeInteractionStream(state, stream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextStatus: ResearchStatus = state.cancelRequested || message === "cancelled" ? "cancelled" : "failed";
      this.updateRecord(state, {
        status: nextStatus,
        error: nextStatus === "cancelled" ? "cancelled" : message,
        updatedAt: new Date().toISOString(),
      });
      await this.flushPersistNow(state);
      this.broadcast(state, "research/updated", { research: state.record }, state.record.lastEventId);
      this.broadcast(
        state,
        "research/failed",
        {
          researchId: state.record.id,
          status: state.record.status,
          error: state.record.error ?? message,
        },
        state.record.lastEventId,
      );
    } finally {
      state.streamPromise = null;
    }
  }

  private async consumeInteractionStream(
    state: ResearchRuntimeState,
    stream: AsyncIterable<ResearchInteractionStreamEvent>,
  ): Promise<void> {
    for await (const event of stream) {
      await this.handleInteractionEvent(state, event);
    }
  }

  private async handleInteractionEvent(
    state: ResearchRuntimeState,
    event: ResearchInteractionStreamEvent,
  ): Promise<void> {
    if (state.cancelRequested && (isContentStartEvent(event) || isContentDeltaEvent(event))) {
      return;
    }

    const eventId = "event_id" in event && typeof event.event_id === "string"
      ? event.event_id
      : null;
    if (eventId) {
      this.updateRecord(state, {
        lastEventId: eventId,
        updatedAt: new Date().toISOString(),
      });
      this.schedulePersist(state);
    }

    if (isInteractionStartEvent(event)) {
      this.updateRecord(state, {
        interactionId: event.interaction.id ?? state.record.interactionId,
        status: normalizeInteractionStatus(event.interaction.status),
        updatedAt: new Date().toISOString(),
      });
      this.schedulePersist(state);
      this.broadcast(state, "research/updated", { research: state.record }, eventId);
      return;
    }

    if (isInteractionStatusUpdateEvent(event)) {
      this.updateRecord(state, {
        status: normalizeInteractionStatus(event.status),
        updatedAt: new Date().toISOString(),
      });
      this.schedulePersist(state);
      this.broadcast(state, "research/updated", { research: state.record }, eventId);
      return;
    }

    if (isContentStartEvent(event)) {
      await this.handleContentStart(state, event, eventId);
      return;
    }

    if (isContentDeltaEvent(event)) {
      await this.handleContentDelta(state, event, eventId);
      return;
    }

    if (isInteractionCompleteEvent(event)) {
      const wasPlanExecution = state.planExecutionMode;
      state.planExecutionMode = false;
      this.updateRecord(state, {
        interactionId: event.interaction.id ?? state.record.interactionId,
        status: normalizeInteractionStatus(event.interaction.status),
        updatedAt: new Date().toISOString(),
      });
      if (wasPlanExecution && state.record.status === "completed") {
        this.updateRecord(state, {
          planPending: true,
        });
      }
      await this.flushPersistNow(state);
      this.broadcast(state, "research/updated", { research: state.record }, eventId);
      if (state.record.status === "completed") {
        this.broadcast(
          state,
          "research/completed",
          {
            researchId: state.record.id,
            research: state.record,
          },
          eventId,
        );
      } else {
        this.broadcast(
          state,
          "research/failed",
          {
            researchId: state.record.id,
            status: state.record.status,
            error: state.record.error ?? state.record.status,
          },
          eventId,
        );
      }
      return;
    }

    if (isErrorEvent(event)) {
      throw new Error(event.error?.message ?? "Research interaction failed.");
    }
  }

  private async handleContentStart(
    state: ResearchRuntimeState,
    event: Interactions.ContentStart,
    eventId: string | null,
  ): Promise<void> {
    const content = asRecord(event.content);
    if (!content) {
      return;
    }
    const contentType = asNonEmptyString(content.type);
    if (!contentType) {
      return;
    }

    if (contentType === "text") {
      const text = asNonEmptyString(content.text);
      if (text) {
        this.appendTextDelta(state, text, eventId);
      }
      await this.upsertSources(state, content.annotations, eventId);
      return;
    }

    if (contentType === "thought") {
      const summary = Array.isArray(content.summary) ? content.summary : [];
      for (const entry of summary) {
        const entryRecord = asRecord(entry);
        const text = asNonEmptyString(entryRecord?.text);
        if (text) {
          this.appendThoughtSummary(state, text, eventId);
        }
      }
      return;
    }

    if (contentType === "url_context_result") {
      await this.upsertUrlContextSources(state, content.result, eventId);
      return;
    }

    if (contentType === "text_annotation") {
      await this.upsertSources(state, content.annotations, eventId);
    }
  }

  private async handleContentDelta(
    state: ResearchRuntimeState,
    event: Interactions.ContentDelta,
    eventId: string | null,
  ): Promise<void> {
    const delta = asRecord(event.delta);
    if (!delta) {
      return;
    }
    const deltaType = asNonEmptyString(delta.type);
    if (!deltaType) {
      return;
    }

    if (deltaType === "text") {
      const text = asNonEmptyString(delta.text);
      if (text) {
        this.appendTextDelta(state, text, eventId);
      }
      return;
    }

    if (deltaType === "thought_summary") {
      const content = asRecord(delta.content);
      const text = asNonEmptyString(content?.text);
      if (text) {
        this.appendThoughtSummary(state, text, eventId);
      }
      return;
    }

    if (deltaType === "text_annotation") {
      await this.upsertSources(state, delta.annotations, eventId);
      return;
    }

    if (deltaType === "url_context_result") {
      await this.upsertUrlContextSources(state, delta.result, eventId);
    }
  }

  private appendTextDelta(
    state: ResearchRuntimeState,
    delta: string,
    eventId: string | null,
  ): void {
    const nextMarkdown = `${state.record.outputsMarkdown}${delta}`;
    this.updateRecord(state, {
      outputsMarkdown: nextMarkdown,
      updatedAt: new Date().toISOString(),
    });
    this.maybeUpgradeTitleFromReport(state, eventId);
    this.schedulePersist(state);
    this.broadcast(
      state,
      "research/textDelta",
      {
        researchId: state.record.id,
        delta,
        ...(eventId ? { eventId } : {}),
      },
      eventId,
    );
  }

  private maybeUpgradeTitleFromReport(
    state: ResearchRuntimeState,
    eventId: string | null,
  ): void {
    const autoTitle = buildResearchTitle(state.record.prompt);
    if (state.record.title !== autoTitle) {
      return;
    }
    const extracted = extractTitleFromMarkdown(state.record.outputsMarkdown);
    if (!extracted || extracted === state.record.title) {
      return;
    }
    this.updateRecord(state, {
      title: extracted,
      updatedAt: new Date().toISOString(),
    });
    this.broadcast(
      state,
      "research/updated",
      { research: state.record },
      eventId,
    );
  }

  private appendThoughtSummary(
    state: ResearchRuntimeState,
    text: string,
    eventId: string | null,
  ): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    const thought: ResearchThoughtSummary = {
      id: eventId ? `thought:${eventId}:${state.record.thoughtSummaries.length}` : crypto.randomUUID(),
      text: normalized,
      ts: new Date().toISOString(),
    };
    this.updateRecord(state, {
      thoughtSummaries: [...state.record.thoughtSummaries, thought],
      updatedAt: new Date().toISOString(),
    });
    this.schedulePersist(state);
    this.broadcast(
      state,
      "research/thoughtDelta",
      {
        researchId: state.record.id,
        thought,
        ...(eventId ? { eventId } : {}),
      },
      eventId,
    );
  }

  private async upsertUrlContextSources(
    state: ResearchRuntimeState,
    result: unknown,
    eventId: string | null,
  ): Promise<void> {
    const sources: ResearchSource[] = [];
    for (const entry of asRecordArray(result)) {
      const url = asNonEmptyString(entry.url);
      if (!url) {
        continue;
      }
      sources.push({
        url,
        title: url,
        sourceType: "url",
        ...(sourceHost(url) ? { host: sourceHost(url) } : {}),
      });
    }
    for (const source of sources) {
      this.upsertSource(state, source, eventId);
    }
  }

  private async upsertSources(
    state: ResearchRuntimeState,
    annotations: unknown,
    eventId: string | null,
  ): Promise<void> {
    const enrichedAnnotations = await enrichCitationAnnotations(annotations) ?? asRecordArray(annotations);
    const nextSources: ResearchSource[] = [];
    for (const annotation of enrichedAnnotations) {
      const type = asNonEmptyString(annotation.type);
      if (type === "url_citation") {
        const url = asNonEmptyString(annotation.url);
        if (!url) {
          continue;
        }
        nextSources.push({
          url,
          ...(asNonEmptyString(annotation.title) ? { title: asNonEmptyString(annotation.title) } : {}),
          sourceType: "url",
          ...(sourceHost(url) ? { host: sourceHost(url) } : {}),
        });
        continue;
      }
      if (type === "file_citation") {
        const url = asNonEmptyString(annotation.document_uri);
        if (!url) {
          continue;
        }
        nextSources.push({
          url,
          ...(asNonEmptyString(annotation.file_name) ? { title: asNonEmptyString(annotation.file_name) } : {}),
          sourceType: "file",
        });
        continue;
      }
      if (type === "place_citation") {
        const url = asNonEmptyString(annotation.url);
        if (!url) {
          continue;
        }
        nextSources.push({
          url,
          ...(asNonEmptyString(annotation.name) ? { title: asNonEmptyString(annotation.name) } : {}),
          sourceType: "place",
          ...(sourceHost(url) ? { host: sourceHost(url) } : {}),
        });
      }
    }

    for (const source of nextSources) {
      this.upsertSource(state, source, eventId);
    }
  }

  private async resolveSourcesViaCitationAnnotations(sources: ResearchSource[]): Promise<ResearchSource[]> {
    if (sources.length === 0) {
      return sources;
    }

    const syntheticAnnotations = sources.map((source, index) => ({
      type: source.sourceType === "place" ? "place_citation" : "url_citation",
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
      start_index: index,
      end_index: index,
    }));
    const enrichedAnnotations = await enrichCitationAnnotations(syntheticAnnotations) ?? syntheticAnnotations;
    return enrichedAnnotations.map((annotation, index): ResearchSource => {
      const original = sources[index]!;
      const annotationRecord = asRecord(annotation);
      const url = asNonEmptyString(annotation.url) ?? original.url;
      const title = asNonEmptyString(annotation.title) ?? asNonEmptyString(annotationRecord?.name) ?? original.title;
      return {
        ...original,
        url,
        ...(title ? { title } : {}),
        ...(sourceHost(url) ? { host: sourceHost(url) } : {}),
      };
    });
  }

  private async resolveStoredSourceDestinations(record: ResearchRecord): Promise<ResearchRecord> {
    if (record.sources.length === 0) {
      return record;
    }

    const sources = await this.resolveSourcesViaCitationAnnotations(record.sources);
    if (JSON.stringify(sources) === JSON.stringify(record.sources)) {
      return record;
    }

    const nextRecord = {
      ...record,
      sources,
    };
    await this.sessionDb.upsertResearch(nextRecord);
    return nextRecord;
  }

  private upsertSource(
    state: ResearchRuntimeState,
    source: ResearchSource,
    eventId: string | null,
  ): void {
    const signature = `${source.sourceType}:${source.url}:${source.title ?? ""}`;
    const existingSignatures = new Set(
      state.record.sources.map((entry) => `${entry.sourceType}:${entry.url}:${entry.title ?? ""}`),
    );
    if (existingSignatures.has(signature)) {
      return;
    }

    this.updateRecord(state, {
      sources: [...state.record.sources, source],
      updatedAt: new Date().toISOString(),
    });
    this.schedulePersist(state);
    this.broadcast(
      state,
      "research/sourceFound",
      {
        researchId: state.record.id,
        source,
        ...(eventId ? { eventId } : {}),
      },
      eventId,
    );
  }

  private getOrCreateState(record: ResearchRecord): ResearchRuntimeState {
    const existing = this.states.get(record.id);
    if (existing) {
      existing.record = record;
      return existing;
    }

    const created: ResearchRuntimeState = {
      record,
      subscribers: new Map(),
      ringBuffer: [],
      persistTimer: null,
      streamPromise: null,
      cancelRequested: false,
      planExecutionMode: false,
    };
    this.states.set(record.id, created);
    return created;
  }

  private schedulePersist(state: ResearchRuntimeState): void {
    if (state.persistTimer) {
      clearTimeout(state.persistTimer);
    }
    state.persistTimer = setTimeout(() => {
      void this.flushPersistNow(state).catch(() => {
        // Persistence retry waits for the next state change.
      });
    }, 150);
  }

  private async flushPersistNow(state: ResearchRuntimeState): Promise<void> {
    if (state.persistTimer) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }
    await this.sessionDb.upsertResearch(state.record);
  }

  private updateRecord(state: ResearchRuntimeState, patch: Partial<ResearchRecord>): void {
    state.record = researchRecordSchema.parse({
      ...state.record,
      ...patch,
    });
  }

  private broadcast(
    state: ResearchRuntimeState,
    method: string,
    params: unknown,
    eventId: string | null,
  ): void {
    state.ringBuffer.push({ method, params, eventId });
    if (state.ringBuffer.length > this.maxBufferedEvents) {
      state.ringBuffer.splice(0, state.ringBuffer.length - this.maxBufferedEvents);
    }
    for (const socket of state.subscribers.values()) {
      this.sendJsonRpc(socket, { method, params });
    }
  }

  private replayBufferedNotifications(
    state: ResearchRuntimeState,
    ws: StartServerSocket,
    afterEventId?: string,
  ): void {
    if (!afterEventId) {
      return;
    }
    const startIndex = state.ringBuffer.findIndex((entry) => entry.eventId === afterEventId);
    const replay = startIndex >= 0 ? state.ringBuffer.slice(startIndex + 1) : [];
    for (const entry of replay) {
      this.sendJsonRpc(ws, {
        method: entry.method,
        params: entry.params,
      });
    }
  }

  private resolveGoogleApiKey(): string {
    const config = this.getConfigImpl();
    const saved = getSavedProviderApiKey(config, "google")?.trim();
    if (saved) {
      return saved;
    }
    const fromEnv = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    throw new Error("Google Deep Research requires a saved Google API key or GOOGLE_GENERATIVE_AI_API_KEY.");
  }

  private async resolveAttachedFiles(params: StartResearchParams): Promise<ResearchInputFile[]> {
    const inlineFiles = (params.attachedFiles ?? [])
      .map((file) => researchInputFileSchema.parse(file));
    if (inlineFiles.length > 0) {
      return inlineFiles;
    }
    const resolved: ResearchInputFile[] = [];
    for (const fileId of params.attachedFileIds ?? []) {
      const file = await this.fileStore.readPendingUpload(fileId);
      if (file) {
        resolved.push(file);
      }
    }
    return resolved;
  }

  private async resumeInFlight(): Promise<void> {
    const runningResearch = this.sessionDb.listRunningResearch();
    await Promise.allSettled(runningResearch.map(async (record) => {
      const state = this.getOrCreateState(record);
      if (!record.interactionId) {
        this.updateRecord(state, {
          status: "failed",
          error: "Research could not be resumed because the interaction id was never stored.",
          updatedAt: new Date().toISOString(),
        });
        await this.flushPersistNow(state);
        return;
      }
      try {
        const stream = await resumeResearchInteractionStream({
          apiKey: this.resolveGoogleApiKey(),
          interactionId: record.interactionId,
          lastEventId: record.lastEventId,
        });
        state.streamPromise = this.consumeInteractionStream(state, stream)
          .catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.updateRecord(state, {
              status: "failed",
              error: message,
              updatedAt: new Date().toISOString(),
            });
            await this.flushPersistNow(state);
          })
          .finally(() => {
            state.streamPromise = null;
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateRecord(state, {
          status: "failed",
          error: message,
          updatedAt: new Date().toISOString(),
        });
        await this.flushPersistNow(state);
      }
    }));
  }
}
