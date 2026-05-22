import type { CodexAppServerJsonRpcRequest } from "../../providers/codexAppServerClient";
import { asArray, asRecord, asString } from "../../shared/recordParsing";
import { isCodexDynamicCoworkToolName } from "../../tools/codexBoundary";
import type { TodoItem } from "../../types";
import { isZodSchema } from "../piRuntimeOptions";
import type { RuntimeRunTurnParams, RuntimeToolDefinition } from "../types";
import { type CodexDynamicToolCallResponse, coworkToolNameFromCodexDynamicName } from "./types";

function validateDynamicToolInput(tool: RuntimeToolDefinition, input: unknown): unknown {
  if (!isZodSchema(tool.inputSchema)) return input;
  const parsed = tool.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(issue?.message ?? "Invalid tool input.");
}

function compactToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "Unknown error.";
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1197)}...` : trimmed;
}

function dynamicToolResultText(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function dynamicToolResponse(success: boolean, text: string): CodexDynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function approvalPromptForRequest(request: CodexAppServerJsonRpcRequest): string {
  const params = asRecord(request.params);
  if (request.method === "item/commandExecution/requestApproval") {
    const command = asString(params?.command) ?? "Approve Codex command execution";
    const cwd = asString(params?.cwd);
    const reason = asString(params?.reason);
    return [
      command,
      cwd ? `cwd: ${cwd}` : "",
      reason ? `reason: ${reason}` : "",
      params?.dangerous === true ? "dangerous: true" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const reason = asString(params?.reason);
  const cwd = asString(params?.cwd);
  const grantRoot = asString(params?.grantRoot);
  const singlePath = asString(params?.path);
  const pathList = [
    ...asArray(params?.paths),
    ...asArray(params?.files),
    ...(singlePath ? [singlePath] : []),
  ]
    .map((value) => asString(value))
    .filter((value): value is string => typeof value === "string");
  const diff = asString(params?.diff) ?? asString(params?.summary);
  return [
    reason ||
      (grantRoot ? `Approve Codex file changes under ${grantRoot}` : "Approve Codex file changes"),
    cwd ? `cwd: ${cwd}` : "",
    pathList.length > 0 ? `paths: ${pathList.join(", ")}` : "",
    diff ? `diff: ${diff}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function normalizeTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const content =
    asString(record.content) ??
    asString(record.title) ??
    asString(record.text) ??
    asString(record.task);
  if (!content) return null;
  const rawStatus = asString(record.status);
  const status =
    rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "pending"
      ? rawStatus
      : rawStatus === "in-progress"
        ? "in_progress"
        : rawStatus === "done"
          ? "completed"
          : "pending";
  return {
    content,
    status,
    activeForm: asString(record.activeForm) ?? asString(record.active_form) ?? content,
  };
}

export function normalizeTodoList(value: unknown): TodoItem[] | null {
  const payload = asRecord(value);
  const candidates =
    asArray(payload?.todos).length > 0
      ? asArray(payload?.todos)
      : asArray(payload?.items).length > 0
        ? asArray(payload?.items)
        : asArray(value);
  const todos = candidates
    .map((item) => normalizeTodoItem(item))
    .filter((item): item is TodoItem => item !== null);
  return todos.length > 0 || candidates.length === 0 ? todos : null;
}

async function handleDynamicToolCall(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<CodexDynamicToolCallResponse> {
  const requestParams = asRecord(request.params);
  const toolName = asString(requestParams?.tool);
  if (!toolName) {
    return dynamicToolResponse(false, "Dynamic tool call is missing a tool name.");
  }
  const coworkToolName = coworkToolNameFromCodexDynamicName(toolName);
  if (!isCodexDynamicCoworkToolName(coworkToolName)) {
    return dynamicToolResponse(
      false,
      `Dynamic tool ${JSON.stringify(toolName)} is owned by Codex app-server natively.`,
    );
  }

  const tool = params.tools[coworkToolName];
  if (!tool) {
    return dynamicToolResponse(false, `Dynamic tool ${JSON.stringify(toolName)} is not available.`);
  }

  try {
    const input = validateDynamicToolInput(tool, requestParams?.arguments ?? {});
    const result = await tool.execute(input);
    return dynamicToolResponse(true, dynamicToolResultText(result));
  } catch (error) {
    return dynamicToolResponse(
      false,
      `Dynamic tool ${JSON.stringify(toolName)} failed: ${compactToolError(error)}`,
    );
  }
}

export async function handleServerRequest(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<unknown> {
  const method = request.method;
  if (method === "item/tool/call") {
    return await handleDynamicToolCall(request, params);
  }
  if (method === "item/tool/requestUserInput" || method === "requestUserInput") {
    const requestParams = asRecord(request.params);
    const question =
      asString(requestParams?.question) ??
      asString(requestParams?.prompt) ??
      "Codex app-server needs input.";
    const options = asArray(requestParams?.options)
      .map((option) => asString(option))
      .filter((option): option is string => typeof option === "string");
    const answer = await params.askUser?.(question, options.length > 0 ? options : undefined);
    return { answer: answer ?? "" };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    const isReadOnlyFileApproval =
      params.shellPolicy === "no_project_write" &&
      params.yolo !== true &&
      method === "item/fileChange/requestApproval";
    const approved =
      params.yolo === true ||
      (!isReadOnlyFileApproval &&
        (await params.approveCommand?.(approvalPromptForRequest(request))) === true);
    return { decision: approved ? "accept" : "decline" };
  }
  return {};
}
