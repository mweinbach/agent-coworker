import { describe, expect, test } from "bun:test";
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_EVENT_TYPES,
  safeParseClientMessage,
  type ServerEvent,
} from "../src/server/protocol";

function expectOk(raw: string) {
  const result = safeParseClientMessage(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ok");
  return result.msg;
}

function expectErr(raw: string) {
  const result = safeParseClientMessage(raw);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected error");
  return result.error;
}

describe("safeParseClientMessage", () => {
  describe("client_hello", () => {
    test("minimal client_hello with required fields", () => {
      const msg = expectOk(JSON.stringify({ type: "client_hello", client: "tui" }));
      expect(msg.type).toBe("client_hello");
      if (msg.type === "client_hello") {
        expect(msg.client).toBe("tui");
      }
    });

    test("client_hello with cli client", () => {
      const msg = expectOk(JSON.stringify({ type: "client_hello", client: "cli" }));
      if (msg.type === "client_hello") {
        expect(msg.client).toBe("cli");
      }
    });

    test("client_hello with custom client string", () => {
      const msg = expectOk(JSON.stringify({ type: "client_hello", client: "custom-ui" }));
      if (msg.type === "client_hello") {
        expect(msg.client).toBe("custom-ui");
      }
    });

    test("client_hello with optional version field", () => {
      const msg = expectOk(
        JSON.stringify({ type: "client_hello", client: "tui", version: "1.0.0" }),
      );
      if (msg.type === "client_hello") {
        expect(msg.version).toBe("1.0.0");
      }
    });

    test("client_hello without version field is valid", () => {
      const msg = expectOk(JSON.stringify({ type: "client_hello", client: "tui" }));
      if (msg.type === "client_hello") {
        expect(msg.version).toBeUndefined();
      }
    });

    test("client_hello missing/invalid client fails", () => {
      expect(expectErr(JSON.stringify({ type: "client_hello" }))).toBe(
        "client_hello missing/invalid client",
      );
      expect(expectErr(JSON.stringify({ type: "client_hello", client: "" }))).toBe(
        "client_hello missing/invalid client",
      );
    });

    test("client_hello invalid version type fails", () => {
      const err = expectErr(JSON.stringify({ type: "client_hello", client: "tui", version: 1 }));
      expect(err).toBe("client_hello invalid version");
    });
  });

  describe("user_message", () => {
    test("minimal user_message", () => {
      const msg = expectOk(
        JSON.stringify({ type: "user_message", sessionId: "s1", text: "hello" }),
      );
      expect(msg.type).toBe("user_message");
      if (msg.type === "user_message") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.text).toBe("hello");
      }
    });

    test("user_message with clientMessageId", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: "hello",
          clientMessageId: "cm-42",
        }),
      );
      if (msg.type === "user_message") {
        expect(msg.clientMessageId).toBe("cm-42");
      }
    });

    test("user_message with empty text", () => {
      const msg = expectOk(
        JSON.stringify({ type: "user_message", sessionId: "s1", text: "" }),
      );
      if (msg.type === "user_message") {
        expect(msg.text).toBe("");
      }
    });

    test("user_message with multiline text", () => {
      const msg = expectOk(
        JSON.stringify({ type: "user_message", sessionId: "s1", text: "line1\nline2\nline3" }),
      );
      if (msg.type === "user_message") {
        expect(msg.text).toBe("line1\nline2\nline3");
      }
    });

    test("user_message invalid clientMessageId fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: "hello",
          clientMessageId: 123,
        }),
      );
      expect(err).toBe("user_message invalid clientMessageId");
    });
  });

  describe("ask_response", () => {
    test("valid ask_response", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "ask_response",
          sessionId: "s1",
          requestId: "r1",
          answer: "yes",
        }),
      );
      expect(msg.type).toBe("ask_response");
      if (msg.type === "ask_response") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.requestId).toBe("r1");
        expect(msg.answer).toBe("yes");
      }
    });

    test("ask_response with empty answer", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "ask_response",
          sessionId: "s1",
          requestId: "r1",
          answer: "",
        }),
      );
      if (msg.type === "ask_response") {
        expect(msg.answer).toBe("");
      }
    });
  });

  describe("approval_response", () => {
    test("approval_response approved", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "approval_response",
          sessionId: "s1",
          requestId: "r1",
          approved: true,
        }),
      );
      expect(msg.type).toBe("approval_response");
      if (msg.type === "approval_response") {
        expect(msg.approved).toBe(true);
      }
    });

    test("approval_response rejected", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "approval_response",
          sessionId: "s1",
          requestId: "r1",
          approved: false,
        }),
      );
      if (msg.type === "approval_response") {
        expect(msg.approved).toBe(false);
      }
    });
  });

  describe("ping", () => {
    test("valid ping requires sessionId", () => {
      const msg = expectOk(JSON.stringify({ type: "ping", sessionId: "s1" }));
      expect(msg.type).toBe("ping");
      if (msg.type === "ping") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("ping missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "ping" }));
      expect(err).toBe("ping missing sessionId");
    });
  });

  describe("set_model", () => {
    test("valid set_model message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_model",
          sessionId: "s1",
          provider: "openai",
          model: "gpt-5.2",
        }),
      );
      expect(msg.type).toBe("set_model");
      if (msg.type === "set_model") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.provider).toBe("openai");
        expect(msg.model).toBe("gpt-5.2");
      }
    });

    test("set_model parses without provider", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_model",
          sessionId: "s1",
          model: "claude-4-5-sonnet",
        }),
      );
      if (msg.type === "set_model") {
        expect(msg.provider).toBeUndefined();
        expect(msg.model).toBe("claude-4-5-sonnet");
      }
    });

    test.each(["codex-cli"])(
      "set_model accepts %s provider",
      (provider) => {
        const msg = expectOk(
          JSON.stringify({
            type: "set_model",
            sessionId: "s1",
            provider,
            model: "test-model",
          })
        );
        if (msg.type === "set_model") {
          expect(msg.provider).toBe(provider);
          expect(msg.model).toBe("test-model");
        }
      }
    );

    test("set_model with empty model fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "set_model",
          sessionId: "s1",
          model: "",
        }),
      );
      expect(err).toContain("set_model missing/invalid model");
    });

    test("set_model with invalid provider fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "set_model",
          sessionId: "s1",
          provider: "not-real",
          model: "gpt-5.2",
        }),
      );
      expect(err).toContain("set_model invalid provider");
    });
  });

  describe("connect_provider hard break", () => {
    test("connect_provider is rejected as unknown type", () => {
      const err = expectErr(
        JSON.stringify({
          type: "connect_provider",
          sessionId: "s1",
          provider: "openai",
          apiKey: "sk-test",
        })
      );
      expect(err.toLowerCase()).toContain("unknown");
    });
  });

  describe("refresh_provider_status", () => {
    test("valid refresh_provider_status", () => {
      const msg = expectOk(JSON.stringify({ type: "refresh_provider_status", sessionId: "s1" }));
      expect(msg.type).toBe("refresh_provider_status");
      if (msg.type === "refresh_provider_status") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("refresh_provider_status missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "refresh_provider_status" }));
      expect(err).toBe("refresh_provider_status missing sessionId");
    });
  });

  describe("provider auth/catalog messages", () => {
    test("provider_catalog_get validation", () => {
      const msg = expectOk(JSON.stringify({ type: "provider_catalog_get", sessionId: "s1" }));
      expect(msg.type).toBe("provider_catalog_get");
      const err = expectErr(JSON.stringify({ type: "provider_catalog_get" }));
      expect(err).toBe("provider_catalog_get missing sessionId");
    });

    test("provider_auth_methods_get validation", () => {
      const msg = expectOk(JSON.stringify({ type: "provider_auth_methods_get", sessionId: "s1" }));
      expect(msg.type).toBe("provider_auth_methods_get");
      const err = expectErr(JSON.stringify({ type: "provider_auth_methods_get" }));
      expect(err).toBe("provider_auth_methods_get missing sessionId");
    });

    test("provider_auth_authorize validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "provider_auth_authorize",
        sessionId: "s1",
        provider: "codex-cli",
        methodId: "oauth_cli",
      }));
      expect(msg.type).toBe("provider_auth_authorize");

      expect(expectErr(JSON.stringify({
        type: "provider_auth_authorize",
        sessionId: "s1",
        provider: "openai",
        methodId: "oauth_cli",
      }))).toBe("provider_auth_authorize unknown methodId");
    });

    test("provider_auth_callback validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "provider_auth_callback",
        sessionId: "s1",
        provider: "codex-cli",
        methodId: "oauth_cli",
      }));
      expect(msg.type).toBe("provider_auth_callback");

      expect(expectErr(JSON.stringify({
        type: "provider_auth_callback",
        sessionId: "s1",
        provider: "codex-cli",
        methodId: "missing",
      }))).toBe("provider_auth_callback unknown methodId");
    });

    test("provider_auth_set_api_key validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "provider_auth_set_api_key",
        sessionId: "s1",
        provider: "openai",
        methodId: "api_key",
        apiKey: "sk-test",
      }));
      expect(msg.type).toBe("provider_auth_set_api_key");

      expect(expectErr(JSON.stringify({
        type: "provider_auth_set_api_key",
        sessionId: "s1",
        provider: "openai",
        methodId: "api_key",
        apiKey: "",
      }))).toBe("provider_auth_set_api_key missing/invalid apiKey");
    });
  });

  describe("list_skills", () => {
    test("valid list_skills message", () => {
      const msg = expectOk(JSON.stringify({ type: "list_skills", sessionId: "s1" }));
      expect(msg.type).toBe("list_skills");
      if (msg.type === "list_skills") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("list_skills missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "list_skills" }));
      expect(err).toBe("list_skills missing sessionId");
    });
  });

  describe("list_commands", () => {
    test("valid list_commands message", () => {
      const msg = expectOk(JSON.stringify({ type: "list_commands", sessionId: "s1" }));
      expect(msg.type).toBe("list_commands");
      if (msg.type === "list_commands") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("list_commands missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "list_commands" }));
      expect(err).toBe("list_commands missing sessionId");
    });
  });

  describe("execute_command", () => {
    test("valid execute_command message", () => {
      const msg = expectOk(JSON.stringify({
        type: "execute_command",
        sessionId: "s1",
        name: "review",
        arguments: "HEAD~3..HEAD",
        clientMessageId: "cm-1",
      }));
      expect(msg.type).toBe("execute_command");
      if (msg.type === "execute_command") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.name).toBe("review");
        expect(msg.arguments).toBe("HEAD~3..HEAD");
        expect(msg.clientMessageId).toBe("cm-1");
      }
    });

    test("execute_command without optional fields", () => {
      const msg = expectOk(JSON.stringify({
        type: "execute_command",
        sessionId: "s1",
        name: "init",
      }));
      if (msg.type === "execute_command") {
        expect(msg.arguments).toBeUndefined();
        expect(msg.clientMessageId).toBeUndefined();
      }
    });

    test("execute_command validation", () => {
      expect(expectErr(JSON.stringify({ type: "execute_command", name: "review" }))).toBe(
        "execute_command missing sessionId"
      );
      expect(expectErr(JSON.stringify({ type: "execute_command", sessionId: "s1" }))).toBe(
        "execute_command missing/invalid name"
      );
      expect(expectErr(JSON.stringify({
        type: "execute_command",
        sessionId: "s1",
        name: "review",
        arguments: 12,
      }))).toBe("execute_command invalid arguments");
      expect(expectErr(JSON.stringify({
        type: "execute_command",
        sessionId: "s1",
        name: "review",
        clientMessageId: 12,
      }))).toBe("execute_command invalid clientMessageId");
    });
  });

  describe("cancel", () => {
    test("valid cancel message", () => {
      const msg = expectOk(JSON.stringify({ type: "cancel", sessionId: "s1" }));
      expect(msg.type).toBe("cancel");
      if (msg.type === "cancel") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("cancel missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "cancel" }));
      expect(err).toBe("cancel missing sessionId");
    });
  });

  describe("read_skill", () => {
    test("valid read_skill message", () => {
      const msg = expectOk(JSON.stringify({ type: "read_skill", sessionId: "s1", skillName: "pdf" }));
      expect(msg.type).toBe("read_skill");
      if (msg.type === "read_skill") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.skillName).toBe("pdf");
      }
    });

    test("read_skill missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "read_skill", skillName: "pdf" }));
      expect(err).toBe("read_skill missing sessionId");
    });

    test("read_skill missing skillName fails", () => {
      const err = expectErr(JSON.stringify({ type: "read_skill", sessionId: "s1" }));
      expect(err).toBe("read_skill missing/invalid skillName");
    });
  });

  describe("disable_skill", () => {
    test("valid disable_skill message", () => {
      const msg = expectOk(JSON.stringify({ type: "disable_skill", sessionId: "s1", skillName: "pdf" }));
      expect(msg.type).toBe("disable_skill");
      if (msg.type === "disable_skill") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.skillName).toBe("pdf");
      }
    });

    test("disable_skill missing fields fail", () => {
      expect(expectErr(JSON.stringify({ type: "disable_skill", skillName: "pdf" }))).toBe("disable_skill missing sessionId");
      expect(expectErr(JSON.stringify({ type: "disable_skill", sessionId: "s1" }))).toBe("disable_skill missing/invalid skillName");
    });
  });

  describe("enable_skill", () => {
    test("valid enable_skill message", () => {
      const msg = expectOk(JSON.stringify({ type: "enable_skill", sessionId: "s1", skillName: "pdf" }));
      expect(msg.type).toBe("enable_skill");
      if (msg.type === "enable_skill") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.skillName).toBe("pdf");
      }
    });

    test("enable_skill missing fields fail", () => {
      expect(expectErr(JSON.stringify({ type: "enable_skill", skillName: "pdf" }))).toBe("enable_skill missing sessionId");
      expect(expectErr(JSON.stringify({ type: "enable_skill", sessionId: "s1" }))).toBe("enable_skill missing/invalid skillName");
    });
  });

  describe("delete_skill", () => {
    test("valid delete_skill message", () => {
      const msg = expectOk(JSON.stringify({ type: "delete_skill", sessionId: "s1", skillName: "pdf" }));
      expect(msg.type).toBe("delete_skill");
      if (msg.type === "delete_skill") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.skillName).toBe("pdf");
      }
    });

    test("delete_skill missing fields fail", () => {
      expect(expectErr(JSON.stringify({ type: "delete_skill", skillName: "pdf" }))).toBe("delete_skill missing sessionId");
      expect(expectErr(JSON.stringify({ type: "delete_skill", sessionId: "s1" }))).toBe("delete_skill missing/invalid skillName");
    });
  });

  describe("set_enable_mcp", () => {
    test("valid set_enable_mcp message", () => {
      const msg = expectOk(JSON.stringify({ type: "set_enable_mcp", sessionId: "s1", enableMcp: true }));
      expect(msg.type).toBe("set_enable_mcp");
      if (msg.type === "set_enable_mcp") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.enableMcp).toBe(true);
      }
    });

    test("set_enable_mcp missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "set_enable_mcp", enableMcp: true }));
      expect(err).toBe("set_enable_mcp missing sessionId");
    });

    test("set_enable_mcp missing/invalid enableMcp fails", () => {
      const err = expectErr(JSON.stringify({ type: "set_enable_mcp", sessionId: "s1", enableMcp: "true" }));
      expect(err).toBe("set_enable_mcp missing/invalid enableMcp");
    });
  });

  describe("harness context messages", () => {
    test("harness_context_get parses", () => {
      const msg = expectOk(JSON.stringify({ type: "harness_context_get", sessionId: "s1" }));
      expect(msg.type).toBe("harness_context_get");
      if (msg.type === "harness_context_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("harness_context_get missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "harness_context_get" }));
      expect(err).toBe("harness_context_get missing sessionId");
    });

    test("harness_context_set parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "harness_context_set",
          sessionId: "s1",
          context: {
            runId: "run-01",
            objective: "Improve startup reliability",
            acceptanceCriteria: ["startup < 800ms"],
            constraints: ["no API changes"],
            metadata: { owner: "platform" },
          },
        })
      );
      expect(msg.type).toBe("harness_context_set");
      if (msg.type === "harness_context_set") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.context.runId).toBe("run-01");
      }
    });

    test("harness_context_set validates required fields", () => {
      const err = expectErr(
        JSON.stringify({
          type: "harness_context_set",
          sessionId: "s1",
          context: {
            runId: "",
            objective: "x",
            acceptanceCriteria: [],
            constraints: [],
          },
        })
      );
      expect(err).toContain("harness_context_set invalid context.runId");
    });
  });

  describe("observability_query", () => {
    test("observability_query parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "observability_query",
          sessionId: "s1",
          query: {
            queryType: "promql",
            query: "sum(rate(vector_component_errors_total[5m]))",
            fromMs: 1000,
            toMs: 2000,
            limit: 10,
          },
        })
      );
      expect(msg.type).toBe("observability_query");
      if (msg.type === "observability_query") {
        expect(msg.query.queryType).toBe("promql");
      }
    });

    test("observability_query rejects invalid queryType", () => {
      const err = expectErr(
        JSON.stringify({
          type: "observability_query",
          sessionId: "s1",
          query: { queryType: "sql", query: "select *" },
        })
      );
      expect(err).toContain("observability_query invalid query.queryType");
    });

    test("observability_query rejects invalid limit", () => {
      const err = expectErr(
        JSON.stringify({
          type: "observability_query",
          sessionId: "s1",
          query: { queryType: "promql", query: "up", limit: 0 },
        }),
      );
      expect(err).toContain("observability_query invalid query.limit");
    });

    test("observability_query rejects too-large limit", () => {
      const err = expectErr(
        JSON.stringify({
          type: "observability_query",
          sessionId: "s1",
          query: { queryType: "promql", query: "up", limit: 10001 },
        }),
      );
      expect(err).toContain("observability_query invalid query.limit");
    });
  });

  describe("harness_slo_evaluate", () => {
    test("harness_slo_evaluate parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "harness_slo_evaluate",
          sessionId: "s1",
          checks: [
            {
              id: "vector_errors",
              type: "custom",
              queryType: "promql",
              query: "sum(rate(vector_component_errors_total[5m]))",
              op: "<=",
              threshold: 0,
              windowSec: 300,
            },
          ],
        })
      );
      expect(msg.type).toBe("harness_slo_evaluate");
      if (msg.type === "harness_slo_evaluate") {
        expect(msg.checks).toHaveLength(1);
      }
    });

    test("harness_slo_evaluate rejects invalid check operator", () => {
      const err = expectErr(
        JSON.stringify({
          type: "harness_slo_evaluate",
          sessionId: "s1",
          checks: [
            {
              id: "c1",
              type: "custom",
              queryType: "promql",
              query: "x",
              op: "lte",
              threshold: 1,
              windowSec: 10,
            },
          ],
        })
      );
      expect(err).toContain("harness_slo_evaluate invalid check.op");
    });

    test("harness_slo_evaluate rejects empty checks", () => {
      const err = expectErr(
        JSON.stringify({
          type: "harness_slo_evaluate",
          sessionId: "s1",
          checks: [],
        }),
      );
      expect(err).toContain("harness_slo_evaluate missing/invalid checks");
    });
  });

  describe("reset", () => {
    test("valid reset message", () => {
      const msg = expectOk(JSON.stringify({ type: "reset", sessionId: "s1" }));
      expect(msg.type).toBe("reset");
      if (msg.type === "reset") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("reset with different sessionId", () => {
      const msg = expectOk(
        JSON.stringify({ type: "reset", sessionId: "abc-def-123" }),
      );
      if (msg.type === "reset") {
        expect(msg.sessionId).toBe("abc-def-123");
      }
    });
  });

  describe("session backup messages", () => {
    test("session_backup_get parses", () => {
      const msg = expectOk(JSON.stringify({ type: "session_backup_get", sessionId: "s1" }));
      expect(msg.type).toBe("session_backup_get");
      if (msg.type === "session_backup_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("session_backup_get missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_get" }));
      expect(err).toContain("session_backup_get missing sessionId");
    });

    test("session_backup_checkpoint parses", () => {
      const msg = expectOk(JSON.stringify({ type: "session_backup_checkpoint", sessionId: "s1" }));
      expect(msg.type).toBe("session_backup_checkpoint");
      if (msg.type === "session_backup_checkpoint") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("session_backup_checkpoint missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_checkpoint" }));
      expect(err).toContain("session_backup_checkpoint missing sessionId");
    });

    test("session_backup_restore parses original target (no checkpointId)", () => {
      const msg = expectOk(JSON.stringify({ type: "session_backup_restore", sessionId: "s1" }));
      expect(msg.type).toBe("session_backup_restore");
      if (msg.type === "session_backup_restore") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.checkpointId).toBeUndefined();
      }
    });

    test("session_backup_restore parses checkpoint target", () => {
      const msg = expectOk(
        JSON.stringify({ type: "session_backup_restore", sessionId: "s1", checkpointId: "cp-0001" })
      );
      expect(msg.type).toBe("session_backup_restore");
      if (msg.type === "session_backup_restore") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.checkpointId).toBe("cp-0001");
      }
    });

    test("session_backup_restore missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_restore" }));
      expect(err).toContain("session_backup_restore missing sessionId");
    });

    test("session_backup_restore non-string checkpointId fails", () => {
      const err = expectErr(
        JSON.stringify({ type: "session_backup_restore", sessionId: "s1", checkpointId: 42 })
      );
      expect(err).toContain("session_backup_restore invalid checkpointId");
    });

    test("session_backup_restore empty checkpointId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_restore", sessionId: "s1", checkpointId: "" }));
      expect(err).toContain("session_backup_restore invalid checkpointId");
    });

    test("session_backup_delete_checkpoint parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "session_backup_delete_checkpoint",
          sessionId: "s1",
          checkpointId: "cp-0003",
        })
      );
      expect(msg.type).toBe("session_backup_delete_checkpoint");
      if (msg.type === "session_backup_delete_checkpoint") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.checkpointId).toBe("cp-0003");
      }
    });

    test("session_backup_delete_checkpoint missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_delete_checkpoint", checkpointId: "cp-1" }));
      expect(err).toContain("session_backup_delete_checkpoint missing sessionId");
    });

    test("session_backup_delete_checkpoint missing checkpointId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_backup_delete_checkpoint", sessionId: "s1" }));
      expect(err).toContain("session_backup_delete_checkpoint missing checkpointId");
    });
  });

  describe("return shape", () => {
    test("ok result has ok: true and msg", () => {
      const result = safeParseClientMessage(
        JSON.stringify({ type: "client_hello", client: "tui" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("msg");
      expect(result).not.toHaveProperty("error");
    });

    test("error result has ok: false and error string", () => {
      const result = safeParseClientMessage("not json");
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("msg");
      if (!result.ok) {
        expect(typeof result.error).toBe("string");
      }
    });
  });

  describe("invalid JSON", () => {
    test("empty string", () => {
      const err = expectErr("");
      expect(err).toBe("Invalid JSON");
    });

    test("malformed JSON - missing closing brace", () => {
      const err = expectErr('{"type": "reset"');
      expect(err).toBe("Invalid JSON");
    });

    test("malformed JSON - trailing comma", () => {
      const err = expectErr('{"type": "reset",}');
      expect(err).toBe("Invalid JSON");
    });

    test("malformed JSON - single quotes", () => {
      const err = expectErr("{'type': 'reset'}");
      expect(err).toBe("Invalid JSON");
    });

    test("malformed JSON - random text", () => {
      const err = expectErr("hello world");
      expect(err).toBe("Invalid JSON");
    });

    test("malformed JSON - just a bare word", () => {
      const err = expectErr("undefined");
      expect(err).toBe("Invalid JSON");
    });
  });

  describe("non-object values", () => {
    test("JSON string literal", () => {
      const err = expectErr('"hello"');
      expect(err).toBe("Expected object");
    });

    test("JSON number literal", () => {
      const err = expectErr("42");
      expect(err).toBe("Expected object");
    });

    test("JSON boolean true", () => {
      const err = expectErr("true");
      expect(err).toBe("Expected object");
    });

    test("JSON boolean false", () => {
      const err = expectErr("false");
      expect(err).toBe("Expected object");
    });

    test("JSON null", () => {
      const err = expectErr("null");
      expect(err).toBe("Expected object");
    });

    test("JSON array", () => {
      const err = expectErr('[{"type":"reset"}]');
      expect(err).toBe("Expected object");
    });

    test("JSON empty array", () => {
      const err = expectErr("[]");
      expect(err).toBe("Expected object");
    });
  });

  describe("missing type field", () => {
    test("empty object", () => {
      const err = expectErr("{}");
      expect(err).toBe("Missing type");
    });

    test("object without type key", () => {
      const err = expectErr(JSON.stringify({ sessionId: "s1", text: "hello" }));
      expect(err).toBe("Missing type");
    });

    test("type is a number", () => {
      const err = expectErr(JSON.stringify({ type: 123 }));
      expect(err).toBe("Missing type");
    });

    test("type is a boolean", () => {
      const err = expectErr(JSON.stringify({ type: true }));
      expect(err).toBe("Missing type");
    });

    test("type is null", () => {
      const err = expectErr(JSON.stringify({ type: null }));
      expect(err).toBe("Missing type");
    });

    test("type is an object", () => {
      const err = expectErr(JSON.stringify({ type: { nested: "value" } }));
      expect(err).toBe("Missing type");
    });

    test("type is an array", () => {
      const err = expectErr(JSON.stringify({ type: ["reset"] }));
      expect(err).toBe("Missing type");
    });
  });

  describe("unknown type values", () => {
    test("completely unknown type", () => {
      const err = expectErr(JSON.stringify({ type: "foobar" }));
      expect(err).toBe("Unknown type: foobar");
    });

    test("server event type used as client message", () => {
      const err = expectErr(JSON.stringify({ type: "server_hello" }));
      expect(err).toBe("Unknown type: server_hello");
    });

    test("server event type assistant_message", () => {
      const err = expectErr(JSON.stringify({ type: "assistant_message" }));
      expect(err).toBe("Unknown type: assistant_message");
    });

    test("type with extra whitespace", () => {
      const err = expectErr(JSON.stringify({ type: " reset " }));
      expect(err).toBe("Unknown type:  reset ");
    });

    test("type with wrong casing", () => {
      const err = expectErr(JSON.stringify({ type: "Client_Hello" }));
      expect(err).toBe("Unknown type: Client_Hello");
    });

    test("empty string type", () => {
      const err = expectErr(JSON.stringify({ type: "" }));
      expect(err).toBe("Unknown type: ");
    });
  });

  describe("extra fields pass through", () => {
    test("client_hello with extra fields", () => {
      const msg = expectOk(
        JSON.stringify({ type: "client_hello", client: "tui", extra: "data", count: 99 }),
      );
      const obj = msg as any;
      expect(obj.extra).toBe("data");
      expect(obj.count).toBe(99);
    });

    test("user_message with extra fields", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: "hi",
          metadata: { source: "test" },
        }),
      );
      const obj = msg as any;
      expect(obj.metadata).toEqual({ source: "test" });
    });

    test("reset with extra fields", () => {
      const msg = expectOk(
        JSON.stringify({ type: "reset", sessionId: "s1", reason: "user-requested" }),
      );
      const obj = msg as any;
      expect(obj.reason).toBe("user-requested");
    });

    test("approval_response with extra fields", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "approval_response",
          sessionId: "s1",
          requestId: "r1",
          approved: true,
          comment: "looks good",
        }),
      );
      const obj = msg as any;
      expect(obj.comment).toBe("looks good");
    });

    test("ask_response with extra fields", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "ask_response",
          sessionId: "s1",
          requestId: "r1",
          answer: "42",
          confidence: 0.95,
        }),
      );
      const obj = msg as any;
      expect(obj.confidence).toBe(0.95);
    });
  });

  describe("protocol exports and additive server event fields", () => {
    test("client/server type lists are unique", () => {
      expect(new Set(CLIENT_MESSAGE_TYPES).size).toBe(CLIENT_MESSAGE_TYPES.length);
      expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
    });

    test("new command message/event types are exported", () => {
      expect(CLIENT_MESSAGE_TYPES.includes("list_commands")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("execute_command")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_catalog_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_methods_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_authorize")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_callback")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_set_api_key")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("commands")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_catalog")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_methods")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_challenge")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_result")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("model_stream_chunk")).toBe(true);
    });

    test("server_hello supports protocolVersion", () => {
      const evt: ServerEvent = {
        type: "server_hello",
        sessionId: "s1",
        protocolVersion: "3.0",
        capabilities: {
          modelStreamChunk: "v1",
        },
        config: {
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp",
          outputDirectory: "/tmp/output",
        },
      };
      expect(evt.type).toBe("server_hello");
      if (evt.type === "server_hello") {
        expect(evt.protocolVersion).toBe("3.0");
        expect(evt.capabilities?.modelStreamChunk).toBe("v1");
      }
    });

    test("error requires code/source", () => {
      const evt: ServerEvent = {
        type: "error",
        sessionId: "s1",
        message: "Invalid JSON",
        code: "invalid_json",
        source: "protocol",
      };
      expect(evt.type).toBe("error");
      if (evt.type === "error") {
        expect(evt.code).toBe("invalid_json");
        expect(evt.source).toBe("protocol");
      }
    });
  });

  describe("edge cases", () => {
    test("deeply nested valid message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: "hi",
          nested: { a: { b: { c: [1, 2, 3] } } },
        }),
      );
      expect(msg.type).toBe("user_message");
    });

    test("message with unicode content", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: "Hello \u4e16\u754c",
        }),
      );
      if (msg.type === "user_message") {
        expect(msg.text).toContain("\u4e16\u754c");
      }
    });

    test("message with very long text", () => {
      const longText = "a".repeat(100_000);
      const msg = expectOk(
        JSON.stringify({ type: "user_message", sessionId: "s1", text: longText }),
      );
      if (msg.type === "user_message") {
        expect(msg.text.length).toBe(100_000);
      }
    });

    test("message with special JSON characters in values", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "user_message",
          sessionId: "s1",
          text: 'quotes "inside" and \\ backslashes',
        }),
      );
      if (msg.type === "user_message") {
        expect(msg.text).toBe('quotes "inside" and \\ backslashes');
      }
    });
  });
});
