import { previewPresentationFile } from "../../presentationPreview";
import { patchSpreadsheetBatch } from "../../spreadsheetEdit";
import {
  readSpreadsheetFileVersion,
  readSpreadsheetWorkbookSnapshot,
} from "../../spreadsheetPreview";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcWorkspaceRequestSchemas } from "../schema.workspace";
import { listWorkspaceSummaries, switchWorkspaceSummary } from "../workspaceCatalog";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createWorkspaceRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "workspace/list": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["workspace/list"].safeParse(
        message.params ?? {},
      );
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }

      const result = await listWorkspaceSummaries({
        workingDirectory: context.getConfig().workingDirectory,
        desktopService: context.desktopService,
        homedir: context.homedir,
      });
      context.jsonrpc.sendResult(ws, message.id, result);
    },

    "workspace/switch": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["workspace/switch"].safeParse(message.params);
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }

      try {
        const result = await switchWorkspaceSummary({
          workspaceId: parsed.data.workspaceId,
          workingDirectory: context.getConfig().workingDirectory,
          desktopService: context.desktopService,
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/bootstrap": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/bootstrap"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);

      const threads = new Map<
        string,
        ReturnType<JsonRpcRouteContext["utils"]["buildThreadFromRecord"]>
      >();
      for (const record of context.threads.listPersisted({ cwd })) {
        if (
          !context.utils.shouldIncludeThreadSummary({
            titleSource: record.titleSource,
            messageCount: record.messageCount,
            hasPendingAsk: record.hasPendingAsk,
            hasPendingApproval: record.hasPendingApproval,
            executionState: record.executionState ?? null,
          })
        ) {
          continue;
        }
        threads.set(record.sessionId, context.utils.buildThreadFromRecord(record));
      }
      for (const runtime of context.threads.listLiveRoot({ cwd })) {
        threads.set(runtime.id, context.utils.buildThreadFromSession(runtime));
      }

      const state = await context.workspaceControl.readState(cwd);

      context.jsonrpc.sendResult(ws, message.id, {
        threads: [...threads.values()].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
        state,
      });
    },

    "cowork/workspace/spreadsheet/workbook": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas[
        "cowork/workspace/spreadsheet/workbook"
      ].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      try {
        const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
        const result = await readSpreadsheetWorkbookSnapshot({
          cwd,
          filePath: parsed.data.path,
          ...(parsed.data.sheetName ? { sheetName: parsed.data.sheetName } : {}),
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/spreadsheet/version": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas[
        "cowork/workspace/spreadsheet/version"
      ].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      try {
        const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
        const result = await readSpreadsheetFileVersion({
          cwd,
          filePath: parsed.data.path,
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/spreadsheet/patch": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/spreadsheet/patch"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      try {
        const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
        const result = await patchSpreadsheetBatch({
          cwd,
          filePath: parsed.data.path,
          operations: parsed.data.operations,
          ...(parsed.data.expectedFileVersion
            ? { expectedFileVersion: parsed.data.expectedFileVersion }
            : {}),
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/presentation/preview": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas[
        "cowork/workspace/presentation/preview"
      ].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      try {
        const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
        const result = await previewPresentationFile({
          cwd,
          filePath: parsed.data.path,
          builtInDir: context.getConfig().builtInDir,
          config: context.getConfig(),
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
