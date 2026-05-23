import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setActiveCoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/runtimeClient";
import { useSkillsStore } from "../apps/mobile/src/features/cowork/skillsStore";
import { useWorkspaceStore } from "../apps/mobile/src/features/cowork/workspaceStore";

beforeEach(() => {
  setActiveCoworkJsonRpcClient(null);
  useWorkspaceStore.getState().clear();
  useSkillsStore.getState().clear();
});

describe("mobile skills store", () => {
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
