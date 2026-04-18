import { z } from "zod";

import { GOOGLE_THINKING_LEVEL_VALUES } from "../../shared/googleThinking";
import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  LOCAL_WEB_SEARCH_PROVIDER_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "../../shared/openaiCompatibleOptions";
import { CHILD_MODEL_ROUTING_MODES, PROVIDER_NAMES } from "../../types";

import {
  legacyEventEnvelope,
  legacyEventsEnvelope,
  nonEmptyTrimmedStringSchema,
  optionalNonEmptyTrimmedStringSchema,
} from "./schema.shared";

const providerNameSchema = z.enum(PROVIDER_NAMES);
const childModelRoutingModeSchema = z.enum(CHILD_MODEL_ROUTING_MODES);

const userProfileSchema = z.object({
  instructions: z.string().optional(),
  work: z.string().optional(),
  details: z.string().optional(),
}).passthrough();

const workspaceFeatureFlagOverridesSchema = z.object({
  experimentalApi: z.boolean().optional(),
  a2ui: z.boolean().optional(),
}).passthrough();

const providerOptionsLocationSchema = z.object({
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().optional(),
}).strict();

const providerOptionsOpenAiSchema = z.object({
  reasoningEffort: z.enum(OPENAI_REASONING_EFFORT_VALUES).optional(),
  reasoningSummary: z.enum(OPENAI_REASONING_SUMMARY_VALUES).optional(),
  textVerbosity: z.enum(OPENAI_TEXT_VERBOSITY_VALUES).optional(),
}).strict();

const providerOptionsCodexSchema = providerOptionsOpenAiSchema.extend({
  webSearchBackend: z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES).optional(),
  webSearchFallbackBackend: z.enum(LOCAL_WEB_SEARCH_PROVIDER_VALUES).optional(),
  webSearchMode: z.enum(CODEX_WEB_SEARCH_MODE_VALUES).optional(),
  webSearch: z.object({
    contextSize: z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES).optional(),
    allowedDomains: z.array(z.string()).optional(),
    location: providerOptionsLocationSchema.optional(),
  }).strict().optional(),
}).strict();

const providerOptionsGoogleSchema = z.object({
  nativeWebSearch: z.boolean().optional(),
  thinkingConfig: z.object({
    thinkingLevel: z.enum(GOOGLE_THINKING_LEVEL_VALUES).optional(),
  }).strict().optional(),
}).strict();

const providerOptionsLmStudioSchema = z.object({
  baseUrl: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  autoLoad: z.boolean().optional(),
  reloadOnContextMismatch: z.boolean().optional(),
}).strict();

const editableProviderOptionsSchema = z.object({
  openai: providerOptionsOpenAiSchema.optional(),
  "codex-cli": providerOptionsCodexSchema.optional(),
  google: providerOptionsGoogleSchema.optional(),
  lmstudio: providerOptionsLmStudioSchema.optional(),
}).strict();

export const sessionStateReadRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
}).strict();

export const sessionDefaultsApplyRequestSchema = z.object({
  cwd: optionalNonEmptyTrimmedStringSchema,
  threadId: optionalNonEmptyTrimmedStringSchema,
  provider: providerNameSchema.optional(),
  model: optionalNonEmptyTrimmedStringSchema,
  enableMcp: z.boolean().optional(),
  config: z.object({
    backupsEnabled: z.boolean().optional(),
    enableA2ui: z.boolean().optional(),
    toolOutputOverflowChars: z.number().int().nullable().optional(),
    clearToolOutputOverflowChars: z.boolean().optional(),
    preferredChildModel: z.string().optional(),
    childModelRoutingMode: childModelRoutingModeSchema.optional(),
    preferredChildModelRef: z.string().optional(),
    allowedChildModelRefs: z.array(z.string()).optional(),
    providerOptions: editableProviderOptionsSchema.optional(),
    userName: z.string().optional(),
    userProfile: userProfileSchema.optional(),
    featureFlags: z.object({
      workspace: workspaceFeatureFlagOverridesSchema.optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).strict();

export const configUpdatedEventSchema = z.object({
  type: z.literal("config_updated"),
  sessionId: nonEmptyTrimmedStringSchema,
  config: z.object({
    provider: z.string(),
    model: z.string(),
    workingDirectory: z.string(),
    outputDirectory: z.string().optional(),
  }).passthrough(),
}).passthrough();

export const sessionSettingsEventSchema = z.object({
  type: z.literal("session_settings"),
  sessionId: nonEmptyTrimmedStringSchema,
  enableMcp: z.boolean(),
  enableMemory: z.boolean(),
  memoryRequireApproval: z.boolean(),
}).passthrough();

export const sessionConfigEventSchema = z.object({
  type: z.literal("session_config"),
  sessionId: nonEmptyTrimmedStringSchema,
  config: z.object({
    yolo: z.boolean().optional(),
    observabilityEnabled: z.boolean().optional(),
    backupsEnabled: z.boolean().optional(),
    defaultBackupsEnabled: z.boolean().optional(),
    enableA2ui: z.boolean().optional(),
    enableMemory: z.boolean().optional(),
    memoryRequireApproval: z.boolean().optional(),
    preferredChildModel: z.string().optional(),
    childModelRoutingMode: childModelRoutingModeSchema.optional(),
    preferredChildModelRef: z.string().optional(),
    allowedChildModelRefs: z.array(z.string()).optional(),
    maxSteps: z.number().int().nonnegative().optional(),
    toolOutputOverflowChars: z.number().int().nullable().optional(),
    defaultToolOutputOverflowChars: z.number().int().nullable().optional(),
    providerOptions: editableProviderOptionsSchema.optional(),
    userName: z.string().optional(),
    userProfile: userProfileSchema.optional(),
    featureFlags: z.object({
      workspace: workspaceFeatureFlagOverridesSchema.optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

export const sessionStateReadResultSchema = legacyEventsEnvelope(z.union([
  configUpdatedEventSchema,
  sessionSettingsEventSchema,
  sessionConfigEventSchema,
]));

export const sessionDefaultsApplyResultSchema = legacyEventEnvelope(sessionConfigEventSchema);
