import path from "node:path";

import { policyAllowsNetwork, resolveSandboxPolicy } from "../../platform/sandbox/policy";
import type { CodexAppServerJsonRpcRequest } from "../../providers/codexAppServerClient";
import { asArray, asRecord, asString } from "../../shared/recordParsing";
import { isCodexDynamicCoworkToolName } from "../../tools/codexBoundary";
import type { TodoItem } from "../../types";
import { assertWritePathAllowed } from "../../utils/permissions";
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

async function assertApprovalPreservesPolicy(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<void> {
  const config = params.config;
  const policy = resolveSandboxPolicy({
    config: config.sandbox,
    readOnlyRole: params.shellPolicy === "no_project_write",
    workingDirectory: config.workingDirectory,
    projectRoot: path.dirname(config.projectCoworkDir),
    outputDirectory: config.outputDirectory,
    uploadsDirectory: config.uploadsDirectory,
    targetPaths: params.agentTargetPaths,
    yolo: params.yolo,
  });
  const readOnly = policy.kind === "read-only" || policy.kind === "no-project-write";
  const scoped = (params.agentTargetPaths?.length ?? 0) > 0;
  if (request.method === "item/commandExecution/requestApproval") {
    // A native approval can rerun a command outside its sandbox. The request
    // does not attest that the hard floors survive accepting it; neither a
    // harmless-looking command nor a human/YOLO approval proves containment.
    if (readOnly || scoped || !policyAllowsNetwork(policy) || params.networkAllowed === false) {
      throw new Error("Command approval cannot preserve this turn's sandbox hard floors.");
    }
    return;
  }
  if (readOnly) throw new Error(`File approval blocked: sandbox mode is ${policy.kind}.`);
  if (!scoped) return;

  const input = asRecord(request.params);
  // Codex grants access to grantRoot, not merely the displayed patch paths.
  // Without an explicit root the extent of a native file grant is ambiguous.
  const grantRoot = asString(input?.grantRoot)?.trim();
  if (!grantRoot) throw new Error("Scoped file approval requires an explicit grantRoot.");
  const cwd = asString(input?.cwd) ?? config.workingDirectory;
  const targets: unknown[] = [grantRoot];
  if (input?.path !== undefined && input.path !== null) targets.push(input.path);
  for (const key of ["paths", "files"]) {
    const entries = input?.[key];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid file approval ${key}.`);
    targets.push(...entries);
  }
  for (const target of targets) {
    if (typeof target !== "string" || !target.trim()) {
      throw new Error("Scoped file approval contains an ambiguous target.");
    }
    await assertWritePathAllowed(
      path.resolve(config.workingDirectory, cwd, target),
      config,
      "write",
      params.agentTargetPaths,
    );
  }
}

function normalizeTodoItem(value: unknown): TodoItem | null {
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
  if (
    !isCodexDynamicCoworkToolName(coworkToolName, {
      preserveScopedFileReadTools: (params.agentTargetPaths?.length ?? 0) > 0,
    })
  ) {
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
    const result = await tool.execute(input, { abortSignal: params.abortSignal });
    return dynamicToolResponse(asRecord(result)?.isError !== true, dynamicToolResultText(result));
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
  if (method === "mcpServer/elicitation/request") {
    const requestParams = asRecord(request.params);
    const serverName = asString(requestParams?.serverName) ?? "unknown MCP server";
    params.log?.(`[codex-app-server] Declined unsupported MCP elicitation from ${serverName}.`);
    return { action: "decline", content: null, _meta: null };
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
    try {
      await params.assertCanMutate?.(
        method === "item/fileChange/requestApproval"
          ? "codex:fileChange"
          : "codex:commandExecution",
      );
      await assertApprovalPreservesPolicy(request, params);
    } catch (error) {
      params.log?.(`[codex-app-server] Native tool approval declined: ${compactToolError(error)}`);
      return { decision: "decline" };
    }
    const approved =
      params.yolo === true ||
      (await params.approveCommand?.(approvalPromptForRequest(request))) === true;
    if (approved) {
      try {
        await params.assertCanMutate?.(
          method === "item/fileChange/requestApproval"
            ? "codex:fileChange"
            : "codex:commandExecution",
        );
        await assertApprovalPreservesPolicy(request, params);
      } catch (error) {
        params.log?.(
          `[codex-app-server] Native tool approval declined after wait: ${compactToolError(error)}`,
        );
        return { decision: "decline" };
      }
    }
    return { decision: approved ? "accept" : "decline" };
  }
  return {};
}
