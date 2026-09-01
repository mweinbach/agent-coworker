import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  invalidateWorkspaceRequests,
  setActiveCoworkJsonRpcClient,
} from "../apps/mobile/src/features/cowork/runtimeClient";
import { useSkillsStore } from "../apps/mobile/src/features/cowork/skillsStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

function deferredResult() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function skillsResult(method: string) {
  if (method === "cowork/skills/list") {
    return { event: { type: "skills_list", sessionId: "control", skills: [] } };
  }
  return {
    event: {
      type: "skills_catalog",
      sessionId: "control",
      catalog: { installations: [], effectiveSkills: [], scopes: [] },
      mutationBlocked: false,
    },
  };
}

beforeEach(() => {
  setActiveCoworkJsonRpcClient(null);
  useWorkspaceStore.getState().clear();
  useSkillsStore.getState().clear();
});

describe("mobile skills store", () => {
  test("a disconnected install releases its pending state and can retry after reconnect", async () => {
    const pending = deferredResult();
    let firstInstall = true;
    const client = {
      transportSessionGeneration: 1,
      call: mock(async (method: string) => {
        if (method === "cowork/skills/install" && firstInstall) {
          firstInstall = false;
          return pending.promise;
        }
        return skillsResult(method);
      }),
    };
    setActiveCoworkJsonRpcClient(client as never);
    useWorkspaceStore.setState({ activeWorkspaceCwd: "/workspace" });

    const installation = useSkillsStore.getState().installSkill("owner/repo", "project");
    expect(useSkillsStore.getState().mutationPending.install).toBe(true);
    invalidateWorkspaceRequests();
    client.transportSessionGeneration += 1;
    pending.reject(new Error("Connection lost"));

    expect(await installation).toBe(false);
    expect(useSkillsStore.getState().mutationPending.install).toBe(false);
    expect(useSkillsStore.getState().error).toBeNull();

    await useSkillsStore.getState().fetchSkills();
    expect(useSkillsStore.getState().mutationPending.install).toBe(false);
    expect(await useSkillsStore.getState().installSkill("owner/repo", "project")).toBe(true);
    expect(useSkillsStore.getState().mutationPending.install).toBe(false);
  });

  test.each(["success", "error"] as const)(
    "an older install %s cannot overwrite a newer request or clear its pending state",
    async (completion) => {
      const older = deferredResult();
      const newer = deferredResult();
      const requests = [older, newer];
      const client = {
        transportSessionGeneration: 1,
        call: mock(async (method: string) => {
          if (method === "cowork/skills/install") return requests.shift()!.promise;
          return skillsResult(method);
        }),
      };
      setActiveCoworkJsonRpcClient(client as never);
      useWorkspaceStore.setState({ activeWorkspaceCwd: "/workspace" });
      const firstInstallation = useSkillsStore.getState().installSkill("owner/first", "project");
      const secondInstallation = useSkillsStore.getState().installSkill("owner/second", "project");
      if (completion === "success") {
        older.resolve(skillsResult("cowork/skills/install"));
      } else {
        older.reject(new Error("Older request failed"));
      }

      expect(await firstInstallation).toBe(false);
      expect(useSkillsStore.getState()).toMatchObject({
        error: null,
        catalog: null,
        mutationPending: { install: true },
      });
      newer.resolve(skillsResult("cowork/skills/install"));
      expect(await secondInstallation).toBe(true);
      expect(useSkillsStore.getState().mutationPending.install).toBe(false);
    },
  );

  test("clearing skills invalidates an old request without adding pending state or errors back", async () => {
    const pending = deferredResult();
    setActiveCoworkJsonRpcClient({
      transportSessionGeneration: 1,
      call: async () => pending.promise,
    } as never);
    useWorkspaceStore.setState({ activeWorkspaceCwd: "/workspace" });
    const installation = useSkillsStore.getState().installSkill("owner/repo", "project");
    useSkillsStore.getState().clear();
    pending.reject(new Error("Old workspace failed"));

    expect(await installation).toBe(false);
    expect(useSkillsStore.getState()).toMatchObject({
      catalog: null,
      error: null,
      mutationPending: {},
    });
  });

  test("an invalidated workspace install cannot clear a new workspace installation", async () => {
    const older = deferredResult();
    const newer = deferredResult();
    const requests = [older, newer];
    const client = {
      transportSessionGeneration: 1,
      call: mock(async (method: string) => {
        if (method === "cowork/skills/install") return requests.shift()!.promise;
        return skillsResult(method);
      }),
    };
    setActiveCoworkJsonRpcClient(client as never);
    useWorkspaceStore.setState({ activeWorkspaceCwd: "/first-workspace" });
    const firstInstallation = useSkillsStore.getState().installSkill("owner/first", "project");
    invalidateWorkspaceRequests();
    client.transportSessionGeneration += 1;
    useSkillsStore.getState().clear();
    useWorkspaceStore.setState({ activeWorkspaceCwd: "/second-workspace" });
    const secondInstallation = useSkillsStore.getState().installSkill("owner/second", "project");
    older.reject(new Error("Old connection lost"));

    expect(await firstInstallation).toBe(false);
    expect(useSkillsStore.getState()).toMatchObject({
      error: null,
      catalog: null,
      mutationPending: { install: true },
    });
    newer.resolve(skillsResult("cowork/skills/install"));
    expect(await secondInstallation).toBe(true);
    expect(useSkillsStore.getState().mutationPending.install).toBe(false);
  });

  test("reports an unsuccessful install so the source draft can be retained", async () => {
    const call = mock(async () => {
      throw new Error("Install failed");
    });
    setActiveCoworkJsonRpcClient({ call } as never);
    useWorkspaceStore.setState({ activeWorkspaceCwd: "/tmp/mobile-workspace" });

    await expect(useSkillsStore.getState().installSkill("owner/repo", "project")).resolves.toBe(
      false,
    );
    expect(useSkillsStore.getState()).toMatchObject({
      error: "Install failed",
      mutationPending: { install: false },
    });

    useWorkspaceStore.setState({ activeWorkspaceCwd: null });
    await expect(useSkillsStore.getState().installSkill("owner/repo", "project")).resolves.toBe(
      false,
    );
    expect(useSkillsStore.getState().error).toBe("No active workspace.");
  });

  test("defers skill refresh while the active workspace is still hydrating", async () => {
    const call = mock(async () => {
      throw new Error("skills should not be requested without a workspace cwd");
    });
    setActiveCoworkJsonRpcClient({ call } as never);

    await expect(useSkillsStore.getState().fetchSkills()).resolves.toBeUndefined();

    expect(call).not.toHaveBeenCalled();
    expect(useSkillsStore.getState()).toMatchObject({
      loading: false,
      error: null,
      skills: [],
      installations: [],
    });
  });
});
