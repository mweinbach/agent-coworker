import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("Edge cases", () => {
    test("sendUserMessage with empty string still processes", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.text).toBe("");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });

    test("reset during idle state does not throw", () => {
      const { session } = makeSession();
      expect(() => session.reset()).not.toThrow();
    });

    test("dispose then sendUserMessage works (running is false after dispose)", async () => {
      const { session } = makeSession();
      session.dispose("test");

      await session.sendUserMessage("after dispose");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // classifyTurnError — error code routing
  // =========================================================================

  describe("classifyTurnError error code routing", () => {
    test("'blocked: path is outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: path is outside the allowed directory");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked: canonical target resolves outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: canonical target resolves outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'outside allowed directories' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Write target is outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked private/internal host' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked private/internal host 192.168.1.1");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked url protocol' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked url protocol ftp");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'oauth' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("OAuth token exchange failed");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'api key' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key provided");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'unsupported provider' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unsupported provider: foobar");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'checkpoint' (without 'unknown checkpoint id') maps to backup_error / backup", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("checkpoint creation timed out");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("'unknown checkpoint id' maps to validation_failed / session (higher priority than checkpoint)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("unknown checkpoint id: cp-9999");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'is required' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Parameter 'filename' is required");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'invalid ' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("invalid configuration value for maxTokens");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'observability' maps to observability_error / observability", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("observability endpoint unreachable");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("observability_error");
        expect(errorEvt.source).toBe("observability");
      }
    });

    test("structured error code/source is routed without message matching", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw { code: "provider_error", source: "provider", message: "Token exchange failed" };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("structured error code without source falls back to default source mapping", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw { code: "permission_denied", message: "Denied" };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("unclassified error maps to internal_error / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Something completely unexpected happened");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as
        | Extract<SessionEvent, { type: "error" }>
        | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("session_busy outcome is 'error' for classified errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const busyFalse = events.find((e) => e.type === "session_busy" && !(e as any).busy) as any;
      expect(busyFalse).toBeDefined();
      expect(busyFalse.outcome).toBe("error");
    });
  });

  // =========================================================================
  // Token usage passthrough
  // =========================================================================
});
