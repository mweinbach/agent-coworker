import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

const mobileRoot = path.resolve(import.meta.dir, "../apps/mobile");

mock.module("expo/metro-config", () => ({
  getDefaultConfig: () => ({
    resolver: {},
    server: {},
  }),
}));

describe("mobile Metro config", () => {
  test("preserves workspace watch folders and module resolution", () => {
    const previousCwd = process.cwd();
    let metroConfig: { resolver: { nodeModulesPaths?: string[] }; watchFolders?: string[] } | null =
      null;
    try {
      process.chdir(mobileRoot);
      metroConfig = require("../apps/mobile/metro.config.js");
    } finally {
      process.chdir(previousCwd);
    }
    if (!metroConfig) {
      throw new Error("Mobile Metro config did not load");
    }

    expect(metroConfig.watchFolders).toEqual([path.resolve(mobileRoot, "../..")]);
    expect(metroConfig.resolver.nodeModulesPaths).toEqual([
      path.resolve(mobileRoot, "node_modules"),
      path.resolve(mobileRoot, "../../node_modules"),
    ]);
  });
});
