import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  maskApiKey,
  readToolApiKey,
  writeToolApiKey,
} from "../src/tools/api-keys";
import type { AiCoworkerPaths, ConnectionStore } from "../src/store/connections";

describe("api-keys tool", () => {
  let tmpDir: string;
  let mockPaths: AiCoworkerPaths;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-keys-test-"));
    mockPaths = {
      rootDir: tmpDir,
      authDir: path.join(tmpDir, "auth"),
      configDir: path.join(tmpDir, "config"),
      sessionsDir: path.join(tmpDir, "sessions"),
      logsDir: path.join(tmpDir, "logs"),
      skillsDir: path.join(tmpDir, "skills"),
      connectionsFile: path.join(tmpDir, "connections.json"),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("readToolApiKey", () => {
    test("returns undefined when store doesn't exist", async () => {
      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBeUndefined();
    });

    test("returns undefined when toolApiKeys is missing", async () => {
      const store: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(store), "utf-8");

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBeUndefined();
    });

    test("returns undefined when key is missing", async () => {
      const store: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {},
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(store), "utf-8");

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBeUndefined();
    });

    test("returns the API key when it exists", async () => {
      const store: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {
          exa: "test-api-key-123",
        },
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(store), "utf-8");

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBe("test-api-key-123");
    });

    test("trims whitespace from API key", async () => {
      const store: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {
          exa: "  test-api-key  ",
        },
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(store), "utf-8");

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBe("test-api-key");
    });

    test("returns undefined for empty string key", async () => {
      const store: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {
          exa: "   ",
        },
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(store), "utf-8");

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
      });
      expect(key).toBeUndefined();
    });

    test("works with mock readStore", async () => {
      const mockStore: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {
          exa: "mocked-key",
        },
      };

      const key = await readToolApiKey({
        name: "exa",
        paths: mockPaths,
        readStore: async () => mockStore,
      });
      expect(key).toBe("mocked-key");
    });
  });

  describe("writeToolApiKey", () => {
    test("writes API key to store", async () => {
      const result = await writeToolApiKey({
        name: "exa",
        apiKey: "new-api-key",
        paths: mockPaths,
      });

      expect(result.maskedApiKey).toBe("new-...-key");
      expect(result.message).toBe("EXA API key saved.");

      const content = await fs.readFile(mockPaths.connectionsFile, "utf-8");
      const store = JSON.parse(content) as ConnectionStore;
      expect(store.toolApiKeys?.exa).toBe("new-api-key");
      expect(store.updatedAt).toBeDefined();
    });

    test("appends to existing toolApiKeys", async () => {
      const existingStore: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {},
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(existingStore), "utf-8");

      await writeToolApiKey({
        name: "exa",
        apiKey: "exa-key",
        paths: mockPaths,
      });

      const content = await fs.readFile(mockPaths.connectionsFile, "utf-8");
      const store = JSON.parse(content) as ConnectionStore;
      expect(store.toolApiKeys?.exa).toBe("exa-key");
    });

    test("overwrites existing key", async () => {
      const existingStore: ConnectionStore = {
        version: 1,
        updatedAt: new Date().toISOString(),
        services: {},
        toolApiKeys: {
          exa: "old-key",
        },
      };
      await fs.mkdir(path.dirname(mockPaths.connectionsFile), { recursive: true });
      await fs.writeFile(mockPaths.connectionsFile, JSON.stringify(existingStore), "utf-8");

      await writeToolApiKey({
        name: "exa",
        apiKey: "new-key",
        paths: mockPaths,
      });

      const content = await fs.readFile(mockPaths.connectionsFile, "utf-8");
      const store = JSON.parse(content) as ConnectionStore;
      expect(store.toolApiKeys?.exa).toBe("new-key");
    });

    test("throws for empty API key", async () => {
      await expect(
        writeToolApiKey({
          name: "exa",
          apiKey: "   ",
          paths: mockPaths,
        })
      ).rejects.toThrow("API key is required.");
    });

    test("trims API key before storing", async () => {
      await writeToolApiKey({
        name: "exa",
        apiKey: "  spaced-key  ",
        paths: mockPaths,
      });

      const content = await fs.readFile(mockPaths.connectionsFile, "utf-8");
      const store = JSON.parse(content) as ConnectionStore;
      expect(store.toolApiKeys?.exa).toBe("spaced-key");
    });

    test("works with mock readStore and writeStore", async () => {
      let writtenStore: ConnectionStore | null = null;

      const result = await writeToolApiKey({
        name: "exa",
        apiKey: "mocked-write",
        paths: mockPaths,
        readStore: async () => ({ version: 1, updatedAt: "old", services: {} }),
        writeStore: async (_, store) => {
          writtenStore = store;
        },
      });

      expect(result.maskedApiKey).toBe("mock...rite");
      expect(writtenStore?.toolApiKeys?.exa).toBe("mocked-write");
    });
  });

  describe("maskApiKey", () => {
    test("masks short keys with asterisks", () => {
      expect(maskApiKey("abcd")).toBe("****");
      expect(maskApiKey("abcdefgh")).toBe("********");
    });

    test("shows first 4 and last 4 for longer keys", () => {
      expect(maskApiKey("abcdefghijklmnopqrstuvwxyz")).toBe("abcd...wxyz");
      expect(maskApiKey("my-secret-api-key-12345")).toBe("my-s...2345");
    });

    test("handles 9 character keys (boundary case)", () => {
      expect(maskApiKey("123456789")).toBe("1234...6789");
    });

    test("handles empty string", () => {
      expect(maskApiKey("")).toBe("****");
    });

    test("handles keys with exactly 8 characters", () => {
      expect(maskApiKey("12345678")).toBe("********");
    });
  });
});
