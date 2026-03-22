import { z } from "zod";

const jsonRpcIdSchema = z.union([z.string(), z.number().finite()]);
const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const JSONRPC_PROTOCOL_VERSION = "0.1";

export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverOverloaded: -32001,
  notInitialized: -32002,
  alreadyInitialized: -32003,
} as const;

export type JsonRpcLiteId = z.infer<typeof jsonRpcIdSchema>;

export type JsonRpcLiteError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcLiteRequest = {
  id: JsonRpcLiteId;
  method: string;
  params?: unknown;
};

export type JsonRpcLiteNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcLiteClientResponse = {
  id: JsonRpcLiteId;
  result?: unknown;
  error?: JsonRpcLiteError;
};

export type JsonRpcLiteClientMessage =
  | JsonRpcLiteRequest
  | JsonRpcLiteNotification
  | JsonRpcLiteClientResponse;

export type JsonRpcLiteResponse =
  | { id: JsonRpcLiteId; result: unknown }
  | { id: JsonRpcLiteId | null; error: JsonRpcLiteError };

export type JsonRpcInitializeParams = {
  clientInfo: {
    name: string;
    title?: string;
    version?: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
};

export type JsonRpcInitializedParams = Record<string, never>;

const initializeParamsSchema = z.object({
  clientInfo: z.object({
    name: nonEmptyTrimmedStringSchema,
    title: z.string().optional(),
    version: z.string().optional(),
  }).strict(),
  capabilities: z.object({
    experimentalApi: z.boolean().optional(),
    optOutNotificationMethods: z.array(nonEmptyTrimmedStringSchema).optional(),
  }).strict().optional(),
}).strict();

const initializedParamsSchema = z.object({}).strict();

const requestEnvelopeSchema = z.object({
  id: jsonRpcIdSchema,
  method: nonEmptyTrimmedStringSchema,
  params: z.unknown().optional(),
}).strict();

const notificationEnvelopeSchema = z.object({
  method: nonEmptyTrimmedStringSchema,
  params: z.unknown().optional(),
}).strict();

const responseEnvelopeSchema = z.object({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z.object({
    code: z.number().finite(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
}).strict().refine((value) => value.result !== undefined || value.error !== undefined, {
  message: "Response must include result or error",
});

export type ParseJsonRpcClientMessageResult =
  | { ok: true; message: JsonRpcLiteClientMessage }
  | { ok: false; error: JsonRpcLiteError; id: JsonRpcLiteId | null };

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string") {
    throw new Error("Invalid JSON");
  }
  return JSON.parse(raw);
}

export function parseJsonRpcClientMessage(raw: unknown): ParseJsonRpcClientMessageResult {
  let parsedRaw: unknown;
  try {
    parsedRaw = safeJsonParse(raw);
  } catch {
    return {
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.parseError,
        message: "Invalid JSON",
      },
    };
  }

  const parsedObject = jsonObjectSchema.safeParse(parsedRaw);
  if (!parsedObject.success) {
    return {
      ok: false,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.invalidRequest,
        message: "Expected object",
      },
    };
  }

  const requestResult = requestEnvelopeSchema.safeParse(parsedObject.data);
  if (requestResult.success) {
    return {
      ok: true,
      message: requestResult.data,
    };
  }

  const notificationResult = notificationEnvelopeSchema.safeParse(parsedObject.data);
  if (notificationResult.success) {
    return {
      ok: true,
      message: notificationResult.data,
    };
  }

  const responseResult = responseEnvelopeSchema.safeParse(parsedObject.data);
  if (responseResult.success) {
    return {
      ok: true,
      message: responseResult.data,
    };
  }

  const maybeId = jsonRpcIdSchema.safeParse(parsedObject.data.id);
  return {
    ok: false,
    id: maybeId.success ? maybeId.data : null,
    error: {
      code: JSONRPC_ERROR_CODES.invalidRequest,
      message: "Invalid JSON-RPC-lite envelope",
    },
  };
}

export function buildJsonRpcErrorResponse(
  id: JsonRpcLiteId | null,
  error: JsonRpcLiteError,
): JsonRpcLiteResponse {
  return { id, error };
}

export function buildJsonRpcResultResponse(
  id: JsonRpcLiteId,
  result: unknown,
): JsonRpcLiteResponse {
  return { id, result };
}

export function parseInitializeParams(
  params: unknown,
): { ok: true; params: JsonRpcInitializeParams } | { ok: false; error: JsonRpcLiteError } {
  const parsed = initializeParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: parsed.error.issues[0]?.message ?? "Invalid initialize params",
      },
    };
  }
  return {
    ok: true,
    params: parsed.data,
  };
}

export function parseInitializedParams(
  params: unknown,
): { ok: true; params: JsonRpcInitializedParams } | { ok: false; error: JsonRpcLiteError } {
  const normalizedParams = params === undefined ? {} : params;
  const parsed = initializedParamsSchema.safeParse(normalizedParams);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: parsed.error.issues[0]?.message ?? "Invalid initialized params",
      },
    };
  }
  return {
    ok: true,
    params: parsed.data,
  };
}
