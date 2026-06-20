import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunTurn } from "../src/agent";
import { createAgentServerRuntime } from "../src/server/runtime/ServerRuntime";
import type { StartServerSocket } from "../src/server/startServer/types";
import type { WebDesktopServiceLike } from "../src/server/webDesktopService";

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
  params?: unknown;
};

type CapturedSocket = StartServerSocket & {
  sentMessages: JsonRpcMessage[];
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSocket(connectionId: string): CapturedSocket {
  const sentMessages: JsonRpcMessage[] = [];
  const socket = {
    data: {
      connectionId,
      selectedSubprotocol: "cowork.jsonrpc.v1",
    },
    sentMessages,
    send(raw: string) {
      sentMessages.push(JSON.parse(raw) as JsonRpcMessage);
      return 1;
    },
  };
  return socket as unknown as CapturedSocket;
}

async function waitForMessage(
  socket: CapturedSocket,
  predicate: (message: JsonRpcMessage) => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<JsonRpcMessage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const index = socket.sentMessages.findIndex(predicate);
    if (index >= 0) {
      const [message] = socket.sentMessages.splice(index, 1);
      if (message) return message;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function expectNoMessage(
  socket: CapturedSocket,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<void> {
  await delay(100);
  expect(socket.sentMessages.some(predicate)).toBe(false);
}

async function initializeConnection(
  runtime: Awaited<ReturnType<typeof createAgentServerRuntime>>,
  socket: CapturedSocket,
): Promise<void> {
  runtime.openConnection(socket);
  runtime.handleDecodedMessage(socket, {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "task-workspace-subscription-test",
        version: "1.0.0",
      },
    },
  });
  const initialized = await waitForMessage(
    socket,
    (message) => message.id === 1,
    "initialize response",
  );
  expect(initialized.error).toBeUndefined();
  runtime.handleDecodedMessage(socket, { method: "initialized" });
}

let nextRequestId = 10;

async function sendRequest(
  runtime: Awaited<ReturnType<typeof createAgentServerRuntime>>,
  socket: CapturedSocket,
  method: string,
  params?: unknown,
): Promise<JsonRpcMessage> {
  const id = nextRequestId++;
  runtime.handleDecodedMessage(socket, {
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  return await waitForMessage(socket, (message) => message.id === id, `${method} response`);
}

function createTaskParams(cwd: string, idempotencyKey: string) {
  return {
    cwd,
    idempotencyKey,
    title: "Catalog workspace task",
    objective: "Prove task notifications are scoped to the authorized workspace.",
    context: "Regression test fixture.",
    requirements: [
      {
        kind: "acceptance_criterion",
        text: "The task notification reaches subscribed catalog-workspace clients.",
      },
    ],
    workItems: [
      {
        key: "deliver",
        title: "Deliver",
        expectedOutputs: ["A task notification"],
      },
    ],
    reviewRequired: false,
    reviewRounds: 0,
  };
}

function createTestRunTurnImpl(): ReturnType<typeof createRunTurn> {
  return createRunTurn({
    createRuntime: () => ({
      name: "pi",
      runTurn: async () => ({
        text: "done",
        responseMessages: [],
      }),
    }),
  });
}

async function createTaskTestRuntime(opts: {
  cwd: string;
  homedir: string;
  desktopService?: WebDesktopServiceLike;
}): Promise<Awaited<ReturnType<typeof createAgentServerRuntime>>> {
  return await createAgentServerRuntime({
    cwd: opts.cwd,
    homedir: opts.homedir,
    env: {
      AGENT_WORKING_DIR: opts.cwd,
      AGENT_PROVIDER: "google",
      AGENT_OBSERVABILITY_ENABLED: "false",
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
    },
    ...(opts.desktopService ? { desktopService: opts.desktopService } : {}),
    runTurnImpl: createTestRunTurnImpl(),
  });
}

function requireCreatedTask(response: JsonRpcMessage): { id: string; revision: number } {
  expect(response.error).toBeUndefined();
  const result = response.result as {
    task?: { id?: unknown; revision?: unknown };
  };
  expect(typeof result.task?.id).toBe("string");
  expect(typeof result.task?.revision).toBe("number");
  if (typeof result.task?.id !== "string" || typeof result.task.revision !== "number") {
    throw new Error("task/create did not return a task id and revision");
  }
  return { id: result.task.id, revision: result.task.revision };
}

function taskNotificationPredicate(
  method: string,
  taskId: string,
  workspacePath: string,
): (message: JsonRpcMessage) => boolean {
  return (message) => {
    if (message.method !== method) return false;
    const params = message.params as { task?: { id?: unknown; workspacePath?: unknown } };
    return params.task?.id === taskId && params.task.workspacePath === workspacePath;
  };
}

async function createAliasedHome(prefix: string): Promise<{
  cleanupRoot: string;
  aliasHome: string;
  realHome: string;
}> {
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const realHomeRoot = path.join(cleanupRoot, "real-home");
  const aliasHome = path.join(cleanupRoot, "home-alias");
  await fs.mkdir(realHomeRoot, { recursive: true });
  await fs.symlink(realHomeRoot, aliasHome, process.platform === "win32" ? "junction" : "dir");
  return {
    cleanupRoot,
    aliasHome,
    realHome: await fs.realpath(realHomeRoot),
  };
}

describe("task workspace subscription routing", () => {
  test("catalog-authorized task reads subscribe the socket to subsequent task updates", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-workspace-subscription-"));
    const activeWorkspace = path.join(home, "active");
    const catalogWorkspace = path.join(home, "catalog");
    const catalogAlias = path.join(home, "catalog-alias");
    const oneOffWorkspace = path.join(home, ".cowork", "chats", "20260620-chat-oneoff");
    const outsideWorkspace = path.join(home, "outside");
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(path.join(activeWorkspace, ".cowork"), { recursive: true });
      await fs.mkdir(catalogWorkspace, { recursive: true });
      await fs.mkdir(oneOffWorkspace, { recursive: true });
      await fs.mkdir(outsideWorkspace, { recursive: true });
      await fs.symlink(catalogWorkspace, catalogAlias, "dir");
      const activePath = await fs.realpath(activeWorkspace);
      const catalogPath = await fs.realpath(catalogWorkspace);
      const oneOffPath = await fs.realpath(oneOffWorkspace);
      const outsidePath = await fs.realpath(outsideWorkspace);
      const desktopService = {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "active",
              name: "Active",
              path: activePath,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "catalog",
              name: "Catalog",
              path: catalogPath,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "one-off",
              name: "One-off chat",
              path: oneOffPath,
              workspaceKind: "oneOffChat",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      } as Partial<WebDesktopServiceLike> as WebDesktopServiceLike;
      const runTurnImpl = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => ({
            text: "done",
            responseMessages: [],
          }),
        }),
      });
      runtime = await createAgentServerRuntime({
        cwd: activePath,
        homedir: home,
        env: {
          AGENT_WORKING_DIR: activePath,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "false",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        },
        desktopService,
        runTurnImpl,
      });

      const reader = makeSocket("reader");
      const mutator = makeSocket("mutator");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);

      const activeListResponse = await sendRequest(runtime, reader, "task/list");
      expect(activeListResponse.error).toBeUndefined();
      expect(activeListResponse.result).toEqual({ tasks: [], total: 0 });

      const activeExactListResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: activePath,
      });
      expect(activeExactListResponse.error).toBeUndefined();
      expect(activeExactListResponse.result).toEqual({ tasks: [], total: 0 });

      const listResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: catalogPath,
      });
      expect(listResponse.error).toBeUndefined();
      expect(listResponse.result).toEqual({ tasks: [], total: 0 });

      const createResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(catalogPath, "catalog-notify"),
      );
      expect(createResponse.error).toBeUndefined();
      const createdResult = createResponse.result as {
        task?: { id?: unknown; revision?: unknown };
      };
      const createdTaskId = createdResult.task?.id;
      const createdRevision = createdResult.task?.revision;
      expect(typeof createdTaskId).toBe("string");
      expect(typeof createdRevision).toBe("number");
      if (typeof createdTaskId !== "string" || typeof createdRevision !== "number") {
        throw new Error("task/create did not return a task id and revision");
      }
      const createdNotification = await waitForMessage(
        reader,
        (message) => message.method === "task/created",
        "task/created notification for catalog workspace",
      );
      expect(createdNotification.params).toMatchObject({
        cwd: catalogPath,
        task: {
          title: "Catalog workspace task",
          workspacePath: catalogPath,
        },
      });
      const updateResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: catalogPath,
        taskId: createdTaskId,
        expectedRevision: createdRevision,
        title: "Catalog workspace task updated",
      });
      expect(updateResponse.error).toBeUndefined();
      const updatedNotification = await waitForMessage(
        reader,
        (message) => {
          if (message.method !== "task/updated") return false;
          const params = message.params as { task?: { title?: unknown; workspacePath?: unknown } };
          return (
            params.task?.title === "Catalog workspace task updated" &&
            params.task.workspacePath === catalogPath
          );
        },
        "task/updated notification for catalog workspace",
      );
      expect(updatedNotification.params).toMatchObject({
        cwd: catalogPath,
        task: {
          title: "Catalog workspace task updated",
          workspacePath: catalogPath,
        },
      });

      const oneOffReader = makeSocket("one-off-reader");
      await initializeConnection(runtime, oneOffReader);
      const oneOffListResponse = await sendRequest(runtime, oneOffReader, "task/list", {
        cwd: oneOffPath,
      });
      expect(oneOffListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const oneOffCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(oneOffPath, "one-off-task-create"),
      );
      expect(oneOffCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(oneOffReader, (message) => message.method === "task/created");

      const oneOffMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: oneOffPath,
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(oneOffMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(oneOffReader, (message) => message.method === "task/updated");

      const aliasReader = makeSocket("alias-reader");
      await initializeConnection(runtime, aliasReader);
      const aliasResponse = await sendRequest(runtime, aliasReader, "task/list", {
        cwd: catalogAlias,
      });
      expect(aliasResponse.error?.message).toContain("cwd must use the canonical workspace path");

      const outsideReader = makeSocket("outside-reader");
      await initializeConnection(runtime, outsideReader);
      const outsideResponse = await sendRequest(runtime, outsideReader, "task/list", {
        cwd: outsidePath,
      });
      expect(outsideResponse.error?.message).toContain("cwd must match an authorized workspace");

      const secondCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(catalogPath, "catalog-notify-second"),
      );
      expect(secondCreateResponse.error).toBeUndefined();
      await expectNoMessage(aliasReader, (message) => message.method === "task/created");
      await expectNoMessage(outsideReader, (message) => message.method === "task/created");
    } finally {
      await runtime?.stop();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("task subscriptions remain additive across authorized catalog workspaces", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-multi-subscription-"));
    const workspaceA = path.join(home, "project-a");
    const workspaceB = path.join(home, "project-b");
    const workspaceC = path.join(home, "project-c");
    const workspaceAliasA = path.join(home, "project-a-alias");
    const oneOffWorkspace = path.join(home, ".cowork", "chats", "20260620-multi-oneoff");
    const outsideWorkspace = path.join(home, "outside");
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(path.join(workspaceA, ".cowork"), { recursive: true });
      await fs.mkdir(path.join(workspaceB, ".cowork"), { recursive: true });
      await fs.mkdir(path.join(workspaceC, ".cowork"), { recursive: true });
      await fs.mkdir(oneOffWorkspace, { recursive: true });
      await fs.mkdir(outsideWorkspace, { recursive: true });
      await fs.symlink(
        workspaceA,
        workspaceAliasA,
        process.platform === "win32" ? "junction" : "dir",
      );
      const workspacePathA = await fs.realpath(workspaceA);
      const workspacePathB = await fs.realpath(workspaceB);
      const workspacePathC = await fs.realpath(workspaceC);
      const oneOffPath = await fs.realpath(oneOffWorkspace);
      const outsidePath = await fs.realpath(outsideWorkspace);
      const desktopService = {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "project-a",
              name: "Project A",
              path: workspacePathA,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "project-b",
              name: "Project B",
              path: workspacePathB,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "project-c",
              name: "Project C",
              path: workspacePathC,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "one-off",
              name: "One-off chat",
              path: oneOffPath,
              workspaceKind: "oneOffChat",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      } as Partial<WebDesktopServiceLike> as WebDesktopServiceLike;
      runtime = await createTaskTestRuntime({
        cwd: workspacePathA,
        homedir: home,
        desktopService,
      });

      const reader = makeSocket("multi-reader");
      const mutator = makeSocket("multi-mutator");
      const rejectedReader = makeSocket("multi-rejected-reader");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);
      await initializeConnection(runtime, rejectedReader);

      for (const cwd of [workspacePathA, workspacePathB, workspacePathB]) {
        const listResponse = await sendRequest(runtime, reader, "task/list", { cwd });
        expect(listResponse.error).toBeUndefined();
        expect(listResponse.result).toEqual({ tasks: [], total: 0 });
      }

      const oneOffListResponse = await sendRequest(runtime, rejectedReader, "task/list", {
        cwd: oneOffPath,
      });
      expect(oneOffListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const outsideListResponse = await sendRequest(runtime, rejectedReader, "task/list", {
        cwd: outsidePath,
      });
      expect(outsideListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized workspace",
      );
      const aliasListResponse = await sendRequest(runtime, rejectedReader, "task/list", {
        cwd: workspaceAliasA,
      });
      expect(aliasListResponse.error?.message ?? "").toContain(
        "cwd must use the canonical workspace path",
      );

      const createdA = requireCreatedTask(
        await sendRequest(runtime, mutator, "task/create", createTaskParams(workspacePathA, "a-1")),
      );
      await waitForMessage(
        reader,
        taskNotificationPredicate("task/created", createdA.id, workspacePathA),
        "task/created for project A",
      );
      await expectNoMessage(
        reader,
        taskNotificationPredicate("task/created", createdA.id, workspacePathA),
      );

      const createdB = requireCreatedTask(
        await sendRequest(runtime, mutator, "task/create", createTaskParams(workspacePathB, "b-1")),
      );
      await waitForMessage(
        reader,
        taskNotificationPredicate("task/created", createdB.id, workspacePathB),
        "task/created for project B",
      );

      await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: workspacePathA,
        taskId: createdA.id,
        expectedRevision: createdA.revision,
        title: "Project A task updated",
      });
      await waitForMessage(
        reader,
        taskNotificationPredicate("task/updated", createdA.id, workspacePathA),
        "task/updated for project A",
      );

      await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: workspacePathB,
        taskId: createdB.id,
        expectedRevision: createdB.revision,
        title: "Project B task updated",
      });
      await waitForMessage(
        reader,
        taskNotificationPredicate("task/updated", createdB.id, workspacePathB),
        "task/updated for project B",
      );

      const createdC = requireCreatedTask(
        await sendRequest(runtime, mutator, "task/create", createTaskParams(workspacePathC, "c-1")),
      );
      await expectNoMessage(
        reader,
        taskNotificationPredicate("task/created", createdC.id, workspacePathC),
      );
      await expectNoMessage(rejectedReader, (message) => message.method?.startsWith("task/"));

      runtime.closeConnection(reader);
      reader.sentMessages.length = 0;
      requireCreatedTask(
        await sendRequest(runtime, mutator, "task/create", createTaskParams(workspacePathA, "a-2")),
      );
      requireCreatedTask(
        await sendRequest(runtime, mutator, "task/create", createTaskParams(workspacePathB, "b-2")),
      );
      await expectNoMessage(reader, (message) => message.method?.startsWith("task/"));
    } finally {
      await runtime?.stop();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("rejects active one-off task RPCs when configured home is a canonical alias", async () => {
    const { cleanupRoot, aliasHome } = await createAliasedHome("task-alias-cli-home-");
    const activeOneOffWorkspace = path.join(
      aliasHome,
      ".cowork",
      "chats",
      "20260620-alias-cli-oneoff",
    );
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(activeOneOffWorkspace, { recursive: true });
      const activeOneOffPath = await fs.realpath(activeOneOffWorkspace);
      runtime = await createTaskTestRuntime({
        cwd: activeOneOffPath,
        homedir: aliasHome,
      });

      const reader = makeSocket("alias-cli-reader");
      const mutator = makeSocket("alias-cli-mutator");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);

      const omittedListResponse = await sendRequest(runtime, reader, "task/list");
      expect(omittedListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const exactListResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: activeOneOffPath,
      });
      expect(exactListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const { cwd: _omittedCreateCwd, ...omittedCreateParams } = createTaskParams(
        activeOneOffPath,
        "alias-cli-create-omitted",
      );
      const omittedCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        omittedCreateParams,
      );
      expect(omittedCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const exactCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(activeOneOffPath, "alias-cli-create-exact"),
      );
      expect(exactCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/created");

      const omittedMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(omittedMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const exactMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: activeOneOffPath,
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(exactMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/updated");
    } finally {
      await runtime?.stop();
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects desktop catalog one-off task RPCs through canonical home aliases", async () => {
    const { cleanupRoot, aliasHome } = await createAliasedHome("task-alias-desktop-home-");
    const activeOneOffWorkspace = path.join(
      aliasHome,
      ".cowork",
      "chats",
      "20260620-alias-desktop-oneoff",
    );
    const promotedProjectWorkspace = path.join(
      aliasHome,
      ".cowork",
      "chats",
      "20260620-promoted-project",
    );
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(activeOneOffWorkspace, { recursive: true });
      await fs.mkdir(promotedProjectWorkspace, { recursive: true });
      const activeOneOffPath = await fs.realpath(activeOneOffWorkspace);
      const promotedProjectPath = await fs.realpath(promotedProjectWorkspace);
      const desktopService = {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "active-one-off",
              name: "Active one-off chat",
              path: activeOneOffPath,
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
            {
              id: "promoted-project",
              name: "Promoted project",
              path: promotedProjectPath,
              workspaceKind: "project",
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      } as Partial<WebDesktopServiceLike> as WebDesktopServiceLike;
      runtime = await createTaskTestRuntime({
        cwd: activeOneOffPath,
        homedir: aliasHome,
        desktopService,
      });

      const oneOffReader = makeSocket("alias-desktop-one-off-reader");
      const mutator = makeSocket("alias-desktop-mutator");
      const projectReader = makeSocket("alias-desktop-project-reader");
      await initializeConnection(runtime, oneOffReader);
      await initializeConnection(runtime, mutator);
      await initializeConnection(runtime, projectReader);

      const omittedListResponse = await sendRequest(runtime, oneOffReader, "task/list");
      expect(omittedListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const exactListResponse = await sendRequest(runtime, oneOffReader, "task/list", {
        cwd: activeOneOffPath,
      });
      expect(exactListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      const exactCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(activeOneOffPath, "alias-desktop-oneoff-create"),
      );
      expect(exactCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(oneOffReader, (message) => message.method === "task/created");
      const exactMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: activeOneOffPath,
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(exactMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(oneOffReader, (message) => message.method === "task/updated");

      const promotedListResponse = await sendRequest(runtime, projectReader, "task/list", {
        cwd: promotedProjectPath,
      });
      expect(promotedListResponse.error).toBeUndefined();
      expect(promotedListResponse.result).toEqual({ tasks: [], total: 0 });
      const promotedTask = requireCreatedTask(
        await sendRequest(
          runtime,
          mutator,
          "task/create",
          createTaskParams(promotedProjectPath, "alias-promoted-project-create"),
        ),
      );
      await waitForMessage(
        projectReader,
        taskNotificationPredicate("task/created", promotedTask.id, promotedProjectPath),
        "task/created for promoted project workspace",
      );
      await expectNoMessage(oneOffReader, (message) => message.method === "task/created");
    } finally {
      await runtime?.stop();
      await fs.rm(cleanupRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects generic task RPCs when the active desktop workspace is a one-off chat", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "task-active-oneoff-")));
    const activeOneOffWorkspace = path.join(home, ".cowork", "chats", "20260620-active-oneoff");
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(activeOneOffWorkspace, { recursive: true });
      const activeOneOffPath = await fs.realpath(activeOneOffWorkspace);
      const desktopService = {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "active-one-off",
              name: "Active one-off chat",
              path: activeOneOffPath,
              createdAt: "2026-06-20T00:00:00.000Z",
              lastOpenedAt: "2026-06-20T00:00:00.000Z",
            },
          ],
        }),
      } as Partial<WebDesktopServiceLike> as WebDesktopServiceLike;
      const runTurnImpl = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => ({
            text: "done",
            responseMessages: [],
          }),
        }),
      });
      runtime = await createAgentServerRuntime({
        cwd: activeOneOffPath,
        homedir: home,
        env: {
          AGENT_WORKING_DIR: activeOneOffPath,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "false",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        },
        desktopService,
        runTurnImpl,
      });

      const reader = makeSocket("active-one-off-reader");
      const mutator = makeSocket("active-one-off-mutator");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);

      const omittedListResponse = await sendRequest(runtime, reader, "task/list");
      expect(omittedListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactListResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: activeOneOffPath,
      });
      expect(exactListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const { cwd: _omittedCreateCwd, ...omittedCreateParams } = createTaskParams(
        activeOneOffPath,
        "active-one-off-create-omitted",
      );
      const omittedCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        omittedCreateParams,
      );
      expect(omittedCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(activeOneOffPath, "active-one-off-create-exact"),
      );
      expect(exactCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/created");

      const omittedMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(omittedMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: activeOneOffPath,
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(exactMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/updated");
    } finally {
      await runtime?.stop();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("rejects generic task RPCs when the non-desktop active workspace is a one-off chat", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "task-cli-oneoff-")));
    const activeOneOffWorkspace = path.join(home, ".cowork", "chats", "20260620-cli-oneoff");
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(activeOneOffWorkspace, { recursive: true });
      const activeOneOffPath = await fs.realpath(activeOneOffWorkspace);
      const runTurnImpl = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => ({
            text: "done",
            responseMessages: [],
          }),
        }),
      });
      runtime = await createAgentServerRuntime({
        cwd: activeOneOffPath,
        homedir: home,
        env: {
          AGENT_WORKING_DIR: activeOneOffPath,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "false",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        },
        runTurnImpl,
      });

      const reader = makeSocket("cli-one-off-reader");
      const mutator = makeSocket("cli-one-off-mutator");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);

      const omittedListResponse = await sendRequest(runtime, reader, "task/list");
      expect(omittedListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactListResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: activeOneOffPath,
      });
      expect(exactListResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const { cwd: _omittedCreateCwd, ...omittedCreateParams } = createTaskParams(
        activeOneOffPath,
        "cli-one-off-create-omitted",
      );
      const omittedCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        omittedCreateParams,
      );
      expect(omittedCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactCreateResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        createTaskParams(activeOneOffPath, "cli-one-off-create-exact"),
      );
      expect(exactCreateResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/created");

      const omittedMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(omittedMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );

      const exactMutationResponse = await sendRequest(runtime, mutator, "task/updateBrief", {
        cwd: activeOneOffPath,
        taskId: "task-one-off",
        expectedRevision: 1,
        title: "Should stay rejected",
      });
      expect(exactMutationResponse.error?.message ?? "").toContain(
        "cwd must match an authorized project workspace",
      );
      await expectNoMessage(reader, (message) => message.method === "task/updated");
    } finally {
      await runtime?.stop();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("non-desktop active project cwd remains authorized for task RPCs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "task-cli-project-"));
    const projectWorkspace = path.join(home, "project");
    let runtime: Awaited<ReturnType<typeof createAgentServerRuntime>> | null = null;
    try {
      await fs.mkdir(projectWorkspace, { recursive: true });
      const projectPath = await fs.realpath(projectWorkspace);
      const runTurnImpl = createRunTurn({
        createRuntime: () => ({
          name: "pi",
          runTurn: async () => ({
            text: "done",
            responseMessages: [],
          }),
        }),
      });
      runtime = await createAgentServerRuntime({
        cwd: projectPath,
        homedir: home,
        env: {
          AGENT_WORKING_DIR: projectPath,
          AGENT_PROVIDER: "google",
          AGENT_OBSERVABILITY_ENABLED: "false",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
        },
        runTurnImpl,
      });

      const reader = makeSocket("cli-project-reader");
      const mutator = makeSocket("cli-project-mutator");
      await initializeConnection(runtime, reader);
      await initializeConnection(runtime, mutator);

      const omittedListResponse = await sendRequest(runtime, reader, "task/list");
      expect(omittedListResponse.error).toBeUndefined();
      expect(omittedListResponse.result).toEqual({ tasks: [], total: 0 });

      const exactListResponse = await sendRequest(runtime, reader, "task/list", {
        cwd: projectPath,
      });
      expect(exactListResponse.error).toBeUndefined();
      expect(exactListResponse.result).toEqual({ tasks: [], total: 0 });

      const { cwd: _omittedCreateCwd, ...omittedCreateParams } = createTaskParams(
        projectPath,
        "cli-project-create-omitted",
      );
      const createResponse = await sendRequest(
        runtime,
        mutator,
        "task/create",
        omittedCreateParams,
      );
      expect(createResponse.error).toBeUndefined();
      const createdResult = createResponse.result as {
        task?: { id?: unknown; revision?: unknown; sourceSessionId?: unknown };
      };
      expect(createdResult.task?.sourceSessionId).toBeNull();
      expect(typeof createdResult.task?.id).toBe("string");
      expect(typeof createdResult.task?.revision).toBe("number");
    } finally {
      await runtime?.stop();
      await fs.rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
