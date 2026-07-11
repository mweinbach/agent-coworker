import type { FileChangeVersion } from "../../../shared/fileVersion";
import { readFileChangeVersion } from "../../../utils/filePreviewRead";
import { canvasDocumentPersistence } from "../../canvasDocumentPersistence";
import { previewPresentationFile } from "../../presentationPreview";
import { patchSpreadsheetBatch } from "../../spreadsheetEdit";
import {
  readSpreadsheetFileVersion,
  readSpreadsheetWorkbookSnapshot,
  resolveWorkspaceFilePath,
} from "../../spreadsheetPreview";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcWorkspaceRequestSchemas } from "../schema.workspace";
import { listWorkspaceSummaries, switchWorkspaceSummary } from "../workspaceCatalog";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createWorkspaceRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  const canvasDocuments = context.canvasDocuments ?? canvasDocumentPersistence;
  const canvasWorkspaceRoot = (method: string): string => {
    const workspaceRoot = context.getConfig().workingDirectory?.trim();
    if (!workspaceRoot) {
      throw new Error(`${method} requires a server-owned workspace root`);
    }
    return workspaceRoot;
  };
  const broadcastFileChanged = async (
    cwd: string,
    filePath: string,
    fallbackVersion: FileChangeVersion,
  ): Promise<void> => {
    const version = await readFileChangeVersion(filePath).catch(() => fallbackVersion);
    try {
      context.jsonrpc.broadcast?.("cowork/workspace/fileChanged", {
        cwd,
        kind: "changed",
        path: filePath,
        version,
      });
    } catch {
      // A notification transport failure must not change the completed mutation result.
    }
  };
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

    "cowork/workspace/document/open": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/open"].safeParse(
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
        const result = await canvasDocuments.open(canvasWorkspaceRoot(message.method), parsed.data);
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/document/revision": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/revision"].safeParse(
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
        const result = await canvasDocuments.revision(
          canvasWorkspaceRoot(message.method),
          parsed.data,
        );
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/document/save": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/save"].safeParse(
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
        const cwd = canvasWorkspaceRoot(message.method);
        const result = await canvasDocuments.save(cwd, parsed.data);
        context.jsonrpc.sendResult(ws, message.id, result);
        if (result.ok && result.status === "saved") {
          await broadcastFileChanged(cwd, result.path, result.revision);
        }
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/document/saveAs": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/saveAs"].safeParse(
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
        const cwd = canvasWorkspaceRoot(message.method);
        const result = await canvasDocuments.saveAs(cwd, parsed.data);
        context.jsonrpc.sendResult(ws, message.id, result);
        if (result.ok && result.status === "saved") {
          await broadcastFileChanged(cwd, result.path, result.revision);
        }
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    "cowork/workspace/document/close": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/document/close"].safeParse(
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
        const result = await canvasDocuments.close(
          canvasWorkspaceRoot(message.method),
          parsed.data,
        );
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
        if (result.ok) {
          try {
            const versionResult = await readSpreadsheetFileVersion({
              cwd,
              filePath: parsed.data.path,
            });
            if (versionResult.ok) {
              await broadcastFileChanged(
                cwd,
                await resolveWorkspaceFilePath(cwd, parsed.data.path),
                versionResult.version,
              );
            }
          } catch {
            // The mutation result remains authoritative when best-effort invalidation metadata fails.
          }
        }
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
