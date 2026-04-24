import { z } from "zod";

import {
  MAX_RESEARCH_UPLOAD_BYTES,
  researchExportFormatSchema,
  researchInputFileSchema,
  researchRecordSchema,
  researchSettingsSchema,
  researchSourceSchema,
  researchThoughtSummarySchema,
} from "../research/types";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";

const researchSummarySchema = researchRecordSchema;
export const MAX_RESEARCH_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_RESEARCH_UPLOAD_BYTES / 3) * 4;

export const jsonRpcResearchRequestSchemas = {
  "research/start": z.object({
    input: z.string().trim().min(1),
    title: z.string().optional(),
    settings: researchSettingsSchema.optional(),
    attachedFileIds: z.array(nonEmptyTrimmedStringSchema).optional(),
  }).strict(),
  "research/list": z.object({}).strict(),
  "research/get": z.object({
    researchId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "research/cancel": z.object({
    researchId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "research/rename": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    title: z.string().trim().min(1).max(200),
  }).strict(),
  "research/followup": z.object({
    parentResearchId: nonEmptyTrimmedStringSchema,
    input: z.string().trim().min(1),
    title: z.string().optional(),
    settings: researchSettingsSchema.optional(),
    attachedFileIds: z.array(nonEmptyTrimmedStringSchema).optional(),
  }).strict(),
  "research/uploadFile": z.object({
    filename: nonEmptyTrimmedStringSchema,
    mimeType: nonEmptyTrimmedStringSchema,
    contentBase64: z.string().min(1).max(MAX_RESEARCH_UPLOAD_BASE64_LENGTH),
  }).strict(),
  "research/attachFile": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    fileId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "research/subscribe": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    afterEventId: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "research/unsubscribe": z.object({
    researchId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "research/export": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    format: researchExportFormatSchema,
  }).strict(),
  "research/approvePlan": z.object({
    researchId: nonEmptyTrimmedStringSchema,
  }).strict(),
  "research/refinePlan": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    input: z.string().trim().min(1),
  }).strict(),
} as const;

export const jsonRpcResearchResultSchemas = {
  "research/start": z.object({
    research: researchSummarySchema,
  }).strict(),
  "research/list": z.object({
    research: z.array(researchSummarySchema),
  }).strict(),
  "research/get": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/cancel": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/rename": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/followup": z.object({
    research: researchSummarySchema,
  }).strict(),
  "research/uploadFile": z.object({
    file: researchInputFileSchema,
  }).strict(),
  "research/attachFile": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/subscribe": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/unsubscribe": z.object({
    status: z.enum(["unsubscribed", "notSubscribed"]),
  }).strict(),
  "research/export": z.object({
    path: nonEmptyTrimmedStringSchema,
    sizeBytes: z.number().int().nonnegative(),
  }).strict(),
  "research/approvePlan": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
  "research/refinePlan": z.object({
    research: researchSummarySchema.nullable(),
  }).strict(),
} as const;

export const jsonRpcResearchNotificationSchemas = {
  "research/updated": z.object({
    research: researchSummarySchema,
  }).strict(),
  "research/textDelta": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    delta: z.string(),
    eventId: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "research/thoughtDelta": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    thought: researchThoughtSummarySchema,
    eventId: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "research/sourceFound": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    source: researchSourceSchema,
    eventId: nonEmptyTrimmedStringSchema.optional(),
  }).strict(),
  "research/completed": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    research: researchSummarySchema,
  }).strict(),
  "research/failed": z.object({
    researchId: nonEmptyTrimmedStringSchema,
    status: z.enum(["failed", "cancelled"]),
    error: z.string(),
  }).strict(),
} as const;
