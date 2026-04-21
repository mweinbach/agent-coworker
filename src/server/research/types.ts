import { z } from "zod";

const isoTimestampSchema = z.string().datetime({ offset: true });
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

export const RESEARCH_STATUS_VALUES = ["pending", "running", "completed", "cancelled", "failed"] as const;
export const RESEARCH_EXPORT_FORMAT_VALUES = ["markdown", "pdf", "docx"] as const;
export const RESEARCH_SOURCE_TYPE_VALUES = ["url", "file", "place"] as const;

export const researchStatusSchema = z.enum(RESEARCH_STATUS_VALUES);
export const researchExportFormatSchema = z.enum(RESEARCH_EXPORT_FORMAT_VALUES);
export const researchSourceTypeSchema = z.enum(RESEARCH_SOURCE_TYPE_VALUES);

export const researchSettingsSchema = z.object({
  googleSearch: z.boolean().default(true),
  urlContext: z.boolean().default(true),
  codeExecution: z.boolean().default(true),
  mcpServersEnabled: z.boolean().default(false),
  planApproval: z.boolean().default(false),
  mcpServerNames: z.array(nonEmptyTrimmedStringSchema).default([]),
}).strict();

export const researchSourceSchema = z.object({
  url: nonEmptyTrimmedStringSchema,
  title: z.string().optional(),
  sourceType: researchSourceTypeSchema.default("url"),
  host: z.string().optional(),
}).strict();

export const researchThoughtSummarySchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  text: nonEmptyTrimmedStringSchema,
  ts: isoTimestampSchema,
}).strict();

export const researchInputFileSchema = z.object({
  fileId: nonEmptyTrimmedStringSchema,
  filename: nonEmptyTrimmedStringSchema,
  mimeType: nonEmptyTrimmedStringSchema,
  path: nonEmptyTrimmedStringSchema,
  uploadedAt: isoTimestampSchema,
  documentName: z.string().trim().min(1).optional(),
}).strict();

export const researchInputsSchema = z.object({
  fileSearchStoreName: z.string().trim().min(1).optional(),
  files: z.array(researchInputFileSchema).default([]),
}).strict();

export const researchRecordSchema = z.object({
  id: nonEmptyTrimmedStringSchema,
  parentResearchId: z.string().trim().min(1).nullable(),
  title: z.string(),
  prompt: z.string(),
  status: researchStatusSchema,
  interactionId: z.string().trim().min(1).nullable(),
  lastEventId: z.string().trim().min(1).nullable(),
  inputs: researchInputsSchema,
  settings: researchSettingsSchema,
  outputsMarkdown: z.string(),
  thoughtSummaries: z.array(researchThoughtSummarySchema),
  sources: z.array(researchSourceSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  error: z.string().nullable(),
}).strict();

export type ResearchStatus = z.infer<typeof researchStatusSchema>;
export type ResearchExportFormat = z.infer<typeof researchExportFormatSchema>;
export type ResearchSource = z.infer<typeof researchSourceSchema>;
export type ResearchThoughtSummary = z.infer<typeof researchThoughtSummarySchema>;
export type ResearchInputFile = z.infer<typeof researchInputFileSchema>;
export type ResearchInputs = z.infer<typeof researchInputsSchema>;
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;
export type ResearchRecord = z.infer<typeof researchRecordSchema>;

export function normalizeResearchSettings(value: unknown): ResearchSettings {
  return researchSettingsSchema.parse(value ?? {});
}

