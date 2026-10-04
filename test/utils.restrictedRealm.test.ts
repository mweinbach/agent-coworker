import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { RESTRICTED_REALM_SEAL_SOURCE } from "../src/utils/restrictedRealm";

describe("restricted realm seal", () => {
  test("strips process, Bun, fetch, and require while leaving JSON usable", () => {
    const context = vm.createContext({
      process: { env: { SECRET: "1" } },
      Bun: { version: "test" },
      fetch: () => {
        throw new Error("fetch must not run");
      },
      require: () => {
        throw new Error("require must not run");
      },
      JSON,
      Promise,
      console,
      Object,
    });

    vm.runInContext(RESTRICTED_REALM_SEAL_SOURCE, context);

    for (const sym of ["process", "Bun", "fetch", "require"]) {
      expect(vm.runInContext(`typeof ${sym}`, context)).toBe("undefined");
    }
    expect(vm.runInContext(`JSON.stringify({ ok: true })`, context)).toBe('{"ok":true}');
  });
});
