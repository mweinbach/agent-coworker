import { describe, expect, test } from "bun:test";
import {
  ASK_SKIP_TOKEN,
  CLIENT_MESSAGE_TYPES,
  SERVER_EVENT_TYPES,
  safeParseServerEvent,
  type ServerEvent,
} from "../src/server/protocol";
import { safeParseClientMessage } from "../src/server/protocolParser";

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

  describe("steer_message", () => {
    test("minimal steer_message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "steer_message",
          sessionId: "s1",
          expectedTurnId: "turn-1",
          text: "tighten the answer",
        }),
      );
      expect(msg.type).toBe("steer_message");
      if (msg.type === "steer_message") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.expectedTurnId).toBe("turn-1");
        expect(msg.text).toBe("tighten the answer");
      }
    });

    test("steer_message with clientMessageId", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "steer_message",
          sessionId: "s1",
          expectedTurnId: "turn-1",
          text: "use bullets",
          clientMessageId: "cm-1",
        }),
      );
      if (msg.type === "steer_message") {
        expect(msg.clientMessageId).toBe("cm-1");
      }
    });

    test("steer_message rejects missing or invalid expectedTurnId", () => {
      expect(expectErr(JSON.stringify({
        type: "steer_message",
        sessionId: "s1",
        text: "continue",
      }))).toBe("steer_message missing/invalid expectedTurnId");

      expect(expectErr(JSON.stringify({
        type: "steer_message",
        sessionId: "s1",
        expectedTurnId: "   ",
        text: "continue",
      }))).toBe("steer_message missing/invalid expectedTurnId");
    });

    test("steer_message rejects blank text", () => {
      const err = expectErr(JSON.stringify({
        type: "steer_message",
        sessionId: "s1",
        expectedTurnId: "turn-1",
        text: "   ",
      }));
      expect(err).toBe("steer_message missing/invalid text");
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

    test("ask_response with empty answer remains syntactically valid (semantic validation happens in session)", () => {
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

    test("ask_response with whitespace answer remains syntactically valid (semantic validation happens in session)", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "ask_response",
          sessionId: "s1",
          requestId: "r1",
          answer: "   ",
        }),
      );
      if (msg.type === "ask_response") {
        expect(msg.answer).toBe("   ");
      }
    });

    test("ask_response accepts explicit skip token", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "ask_response",
          sessionId: "s1",
          requestId: "r1",
          answer: ASK_SKIP_TOKEN,
        }),
      );
      if (msg.type === "ask_response") {
        expect(msg.answer).toBe(ASK_SKIP_TOKEN);
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

  describe("apply_session_defaults", () => {
    test("valid apply_session_defaults accepts composite defaults payloads", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "apply_session_defaults",
          sessionId: "s1",
          provider: "openai",
          model: "gpt-5.2",
          enableMcp: false,
          config: {
            backupsEnabled: true,
            preferredChildModel: "gpt-5.2-mini",
            childModelRoutingMode: "same-provider",
          },
        }),
      );
      expect(msg.type).toBe("apply_session_defaults");
      if (msg.type === "apply_session_defaults") {
        expect(msg.provider).toBe("openai");
        expect(msg.model).toBe("gpt-5.2");
        expect(msg.enableMcp).toBe(false);
        expect(msg.config?.preferredChildModel).toBe("gpt-5.2-mini");
      }
    });

    test("apply_session_defaults requires provider and model together", () => {
      expect(
        expectErr(JSON.stringify({ type: "apply_session_defaults", sessionId: "s1", provider: "openai" })),
      ).toBe("apply_session_defaults provider and model must be supplied together");
      expect(
        expectErr(JSON.stringify({ type: "apply_session_defaults", sessionId: "s1", model: "gpt-5.2" })),
      ).toBe("apply_session_defaults provider and model must be supplied together");
    });

    test("apply_session_defaults validates config payloads with set_config semantics", () => {
      expect(
        expectErr(JSON.stringify({
          type: "apply_session_defaults",
          sessionId: "s1",
          config: { toolOutputOverflowChars: 25_000, clearToolOutputOverflowChars: true },
        })),
      ).toBe("apply_session_defaults config.toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars");
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

    test("user_config_get validation", () => {
      const msg = expectOk(JSON.stringify({ type: "user_config_get", sessionId: "s1" }));
      expect(msg.type).toBe("user_config_get");
      const err = expectErr(JSON.stringify({ type: "user_config_get" }));
      expect(err).toBe("user_config_get missing sessionId");
    });

    test("user_config_set validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          awsBedrockProxyBaseUrl: "https://proxy.example.com/v1/",
        },
      }));
      expect(msg.type).toBe("user_config_set");
      if (msg.type === "user_config_set") {
        expect(msg.config.awsBedrockProxyBaseUrl).toBe("https://proxy.example.com/v1/");
      }

      const clearMsg = expectOk(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          awsBedrockProxyBaseUrl: null,
        },
      }));
      expect(clearMsg.type).toBe("user_config_set");
      if (clearMsg.type === "user_config_set") {
        expect(clearMsg.config.awsBedrockProxyBaseUrl).toBeNull();
      }

      const legacyMsg = expectOk(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          openaiProxyBaseUrl: "https://legacy.proxy.example/v1/",
        },
      }));
      expect(legacyMsg.type).toBe("user_config_set");
      if (legacyMsg.type === "user_config_set") {
        expect(legacyMsg.config.awsBedrockProxyBaseUrl).toBe("https://legacy.proxy.example/v1/");
      }

      expect(expectErr(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
      }))).toBe("user_config_set missing/invalid config");

      expect(expectErr(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: { somethingElse: true },
      }))).toBe("user_config_set config only supports awsBedrockProxyBaseUrl (legacy openaiProxyBaseUrl also accepted)");

      expect(expectErr(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          awsBedrockProxyBaseUrl: 42,
        },
      }))).toBe("user_config_set config.awsBedrockProxyBaseUrl must be string or null");

      expect(expectErr(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          awsBedrockProxyBaseUrl: "not-a-url",
        },
      }))).toBe("user_config_set config.awsBedrockProxyBaseUrl must be a valid http(s) URL");

      expect(expectErr(JSON.stringify({
        type: "user_config_set",
        sessionId: "s1",
        config: {
          awsBedrockProxyBaseUrl: "httpx://proxy.example.com/v1",
        },
      }))).toBe("user_config_set config.awsBedrockProxyBaseUrl must be a valid http(s) URL");
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

    test("provider_auth_logout validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "provider_auth_logout",
        sessionId: "s1",
        provider: "codex-cli",
      }));
      expect(msg.type).toBe("provider_auth_logout");
      expect(expectErr(JSON.stringify({
        type: "provider_auth_logout",
        sessionId: "s1",
        provider: "nope",
      }))).toBe("provider_auth_logout missing/invalid provider");
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

    test("provider_auth_copy_api_key validation", () => {
      const msg = expectOk(JSON.stringify({
        type: "provider_auth_copy_api_key",
        sessionId: "s1",
        provider: "opencode-zen",
        sourceProvider: "opencode-go",
      }));
      expect(msg.type).toBe("provider_auth_copy_api_key");

      expect(expectErr(JSON.stringify({
        type: "provider_auth_copy_api_key",
        sessionId: "s1",
        provider: "opencode-zen",
        sourceProvider: "nope",
      }))).toBe("provider_auth_copy_api_key missing/invalid sourceProvider");
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

    test("valid cancel message can include subagents", () => {
      const msg = expectOk(JSON.stringify({ type: "cancel", sessionId: "s1", includeSubagents: true }));
      expect(msg.type).toBe("cancel");
      if (msg.type === "cancel") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.includeSubagents).toBe(true);
      }
    });

    test("cancel missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "cancel" }));
      expect(err).toBe("cancel missing sessionId");
    });

    test("cancel invalid includeSubagents fails", () => {
      const err = expectErr(JSON.stringify({ type: "cancel", sessionId: "s1", includeSubagents: "yes" }));
      expect(err).toBe("cancel invalid includeSubagents");
    });
  });

  describe("session_close", () => {
    test("valid session_close message", () => {
      const msg = expectOk(JSON.stringify({ type: "session_close", sessionId: "s1" }));
      expect(msg.type).toBe("session_close");
      if (msg.type === "session_close") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("session_close missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "session_close" }));
      expect(err).toBe("session_close missing sessionId");
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

  describe("installation-based skill manager messages", () => {
    test("skills_catalog_get parses", () => {
      const msg = expectOk(JSON.stringify({ type: "skills_catalog_get", sessionId: "s1" }));
      expect(msg.type).toBe("skills_catalog_get");
      if (msg.type === "skills_catalog_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("skill_installation_get parses", () => {
      const msg = expectOk(JSON.stringify({ type: "skill_installation_get", sessionId: "s1", installationId: "inst-1" }));
      expect(msg.type).toBe("skill_installation_get");
      if (msg.type === "skill_installation_get") {
        expect(msg.installationId).toBe("inst-1");
      }
    });

    test("skill_install_preview and skill_install validate source and target scope", () => {
      const preview = expectOk(JSON.stringify({
        type: "skill_install_preview",
        sessionId: "s1",
        sourceInput: "openai/skills",
        targetScope: "project",
      }));
      expect(preview.type).toBe("skill_install_preview");

      const install = expectOk(JSON.stringify({
        type: "skill_install",
        sessionId: "s1",
        sourceInput: "/tmp/skill",
        targetScope: "global",
      }));
      expect(install.type).toBe("skill_install");

      expect(expectErr(JSON.stringify({
        type: "skill_install_preview",
        sessionId: "s1",
        sourceInput: "",
        targetScope: "project",
      }))).toBe("skill_install_preview missing/invalid sourceInput");
      expect(expectErr(JSON.stringify({
        type: "skill_install",
        sessionId: "s1",
        sourceInput: "openai/skills",
        targetScope: "user",
      }))).toContain("expected one of");
    });

    test("installation mutation messages parse", () => {
      const enable = expectOk(JSON.stringify({ type: "skill_installation_enable", sessionId: "s1", installationId: "inst-1" }));
      expect(enable.type).toBe("skill_installation_enable");

      const disable = expectOk(JSON.stringify({ type: "skill_installation_disable", sessionId: "s1", installationId: "inst-1" }));
      expect(disable.type).toBe("skill_installation_disable");

      const del = expectOk(JSON.stringify({ type: "skill_installation_delete", sessionId: "s1", installationId: "inst-1" }));
      expect(del.type).toBe("skill_installation_delete");

      const copy = expectOk(JSON.stringify({
        type: "skill_installation_copy",
        sessionId: "s1",
        installationId: "inst-1",
        targetScope: "global",
      }));
      expect(copy.type).toBe("skill_installation_copy");

      const check = expectOk(JSON.stringify({ type: "skill_installation_check_update", sessionId: "s1", installationId: "inst-1" }));
      expect(check.type).toBe("skill_installation_check_update");

      const update = expectOk(JSON.stringify({ type: "skill_installation_update", sessionId: "s1", installationId: "inst-1" }));
      expect(update.type).toBe("skill_installation_update");
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

  describe("mcp_servers_get", () => {
    test("valid mcp_servers_get message", () => {
      const msg = expectOk(JSON.stringify({ type: "mcp_servers_get", sessionId: "s1" }));
      expect(msg.type).toBe("mcp_servers_get");
      if (msg.type === "mcp_servers_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("mcp_servers_get missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "mcp_servers_get" }));
      expect(err).toBe("mcp_servers_get missing sessionId");
    });
  });

  describe("mcp_server_upsert", () => {
    test("valid mcp_server_upsert message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "mcp_server_upsert",
          sessionId: "s1",
          server: {
            name: "grep",
            transport: { type: "http", url: "https://mcp.grep.app" },
            auth: { type: "oauth", oauthMode: "auto" },
          },
        }),
      );
      expect(msg.type).toBe("mcp_server_upsert");
      if (msg.type === "mcp_server_upsert") {
        expect(msg.server.name).toBe("grep");
      }
    });

    test("mcp_server_upsert validates server payload", () => {
      expect(expectErr(JSON.stringify({ type: "mcp_server_upsert", server: {} }))).toBe(
        "mcp_server_upsert missing sessionId",
      );
      expect(
        expectErr(
          JSON.stringify({
            type: "mcp_server_upsert",
            sessionId: "s1",
            server: { name: "", transport: { type: "stdio", command: "echo" } },
          }),
        ),
      ).toContain("mcp_server_upsert invalid server");
      expect(
        expectErr(
          JSON.stringify({
            type: "mcp_server_upsert",
            sessionId: "s1",
            server: { name: "ok", transport: { type: "stdio", command: "echo" } },
            previousName: "",
          }),
        ),
      ).toBe("mcp_server_upsert invalid previousName");
    });
  });

  describe("mcp_server_delete", () => {
    test("valid mcp_server_delete message", () => {
      const msg = expectOk(JSON.stringify({ type: "mcp_server_delete", sessionId: "s1", name: "grep" }));
      expect(msg.type).toBe("mcp_server_delete");
    });

    test("mcp_server_delete validates required fields", () => {
      expect(expectErr(JSON.stringify({ type: "mcp_server_delete", name: "grep" }))).toBe(
        "mcp_server_delete missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "mcp_server_delete", sessionId: "s1", name: "" }))).toBe(
        "mcp_server_delete missing/invalid name",
      );
    });
  });

  describe("mcp_server_validate", () => {
    test("valid mcp_server_validate message", () => {
      const msg = expectOk(JSON.stringify({ type: "mcp_server_validate", sessionId: "s1", name: "grep" }));
      expect(msg.type).toBe("mcp_server_validate");
    });
  });

  describe("mcp_server_auth_authorize", () => {
    test("valid mcp_server_auth_authorize message", () => {
      const msg = expectOk(
        JSON.stringify({ type: "mcp_server_auth_authorize", sessionId: "s1", name: "grep" }),
      );
      expect(msg.type).toBe("mcp_server_auth_authorize");
    });
  });

  describe("mcp_server_auth_callback", () => {
    test("valid mcp_server_auth_callback with optional code", () => {
      const withCode = expectOk(
        JSON.stringify({ type: "mcp_server_auth_callback", sessionId: "s1", name: "grep", code: "abc" }),
      );
      expect(withCode.type).toBe("mcp_server_auth_callback");

      const noCode = expectOk(
        JSON.stringify({ type: "mcp_server_auth_callback", sessionId: "s1", name: "grep" }),
      );
      expect(noCode.type).toBe("mcp_server_auth_callback");
    });

    test("mcp_server_auth_callback validates fields", () => {
      expect(expectErr(JSON.stringify({ type: "mcp_server_auth_callback", sessionId: "s1", name: "grep", code: 12 }))).toBe(
        "mcp_server_auth_callback invalid code",
      );
    });
  });

  describe("mcp_server_auth_set_api_key", () => {
    test("valid mcp_server_auth_set_api_key message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "mcp_server_auth_set_api_key",
          sessionId: "s1",
          name: "grep",
          apiKey: "secret",
        }),
      );
      expect(msg.type).toBe("mcp_server_auth_set_api_key");
    });

    test("mcp_server_auth_set_api_key validates required fields", () => {
      expect(expectErr(JSON.stringify({ type: "mcp_server_auth_set_api_key", sessionId: "s1", name: "grep" }))).toBe(
        "mcp_server_auth_set_api_key missing/invalid apiKey",
      );
    });
  });

  describe("mcp_servers_migrate_legacy", () => {
    test("valid mcp_servers_migrate_legacy message", () => {
      const msg = expectOk(
        JSON.stringify({ type: "mcp_servers_migrate_legacy", sessionId: "s1", scope: "workspace" }),
      );
      expect(msg.type).toBe("mcp_servers_migrate_legacy");
    });

    test("mcp_servers_migrate_legacy validates scope", () => {
      expect(expectErr(JSON.stringify({ type: "mcp_servers_migrate_legacy", sessionId: "s1", scope: "bad" }))).toBe(
        "mcp_servers_migrate_legacy missing/invalid scope",
      );
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

  describe("removed observability query/slo messages", () => {
    test("observability_query is rejected as unknown", () => {
      const err = expectErr(
        JSON.stringify({
          type: "observability_query",
          sessionId: "s1",
          query: { queryType: "promql", query: "up" },
        })
      );
      expect(err).toBe("Unknown type: observability_query");
    });

    test("harness_slo_evaluate is rejected as unknown", () => {
      const err = expectErr(
        JSON.stringify({
          type: "harness_slo_evaluate",
          sessionId: "s1",
          checks: [],
        })
      );
      expect(err).toBe("Unknown type: harness_slo_evaluate");
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

  describe("get_messages", () => {
    test("valid get_messages without pagination", () => {
      const msg = expectOk(JSON.stringify({ type: "get_messages", sessionId: "s1" }));
      expect(msg.type).toBe("get_messages");
      if (msg.type === "get_messages") {
        expect(msg.offset).toBeUndefined();
        expect(msg.limit).toBeUndefined();
      }
    });

    test("valid get_messages with offset/limit", () => {
      const msg = expectOk(
        JSON.stringify({ type: "get_messages", sessionId: "s1", offset: 10, limit: 50 }),
      );
      if (msg.type === "get_messages") {
        expect(msg.offset).toBe(10);
        expect(msg.limit).toBe(50);
      }
    });

    test("get_messages validates required and numeric fields", () => {
      expect(expectErr(JSON.stringify({ type: "get_messages" }))).toBe("get_messages missing sessionId");
      expect(
        expectErr(JSON.stringify({ type: "get_messages", sessionId: "s1", offset: -1 })),
      ).toBe("get_messages invalid offset");
      expect(
        expectErr(JSON.stringify({ type: "get_messages", sessionId: "s1", offset: "1" })),
      ).toBe("get_messages invalid offset");
      expect(
        expectErr(JSON.stringify({ type: "get_messages", sessionId: "s1", limit: 0 })),
      ).toBe("get_messages invalid limit");
      expect(
        expectErr(JSON.stringify({ type: "get_messages", sessionId: "s1", limit: "10" })),
      ).toBe("get_messages invalid limit");
    });
  });

  describe("set_session_title", () => {
    test("valid set_session_title", () => {
      const msg = expectOk(
        JSON.stringify({ type: "set_session_title", sessionId: "s1", title: "Session A" }),
      );
      expect(msg.type).toBe("set_session_title");
      if (msg.type === "set_session_title") {
        expect(msg.title).toBe("Session A");
      }
    });

    test("set_session_title missing fields fail", () => {
      expect(expectErr(JSON.stringify({ type: "set_session_title", title: "A" }))).toBe(
        "set_session_title missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "set_session_title", sessionId: "s1" }))).toBe(
        "set_session_title missing/invalid title",
      );
      expect(
        expectErr(JSON.stringify({ type: "set_session_title", sessionId: "s1", title: "" })),
      ).toBe("set_session_title missing/invalid title");
    });
  });

  describe("list_sessions", () => {
    test("valid list_sessions message", () => {
      const msg = expectOk(JSON.stringify({ type: "list_sessions", sessionId: "s1" }));
      expect(msg.type).toBe("list_sessions");
      if (msg.type === "list_sessions") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.scope).toBeUndefined();
      }
    });

    test("list_sessions accepts workspace scope", () => {
      const msg = expectOk(JSON.stringify({ type: "list_sessions", sessionId: "s1", scope: "workspace" }));
      expect(msg.type).toBe("list_sessions");
      if (msg.type === "list_sessions") {
        expect(msg.scope).toBe("workspace");
      }
    });

    test("list_sessions missing sessionId fails", () => {
      const err = expectErr(JSON.stringify({ type: "list_sessions" }));
      expect(err).toBe("list_sessions missing sessionId");
    });

    test("list_sessions rejects invalid scope", () => {
      expect(expectErr(JSON.stringify({ type: "list_sessions", sessionId: "s1", scope: "user" }))).toBe(
        "list_sessions invalid scope",
      );
    });
  });

  describe("get_session_snapshot", () => {
    test("valid get_session_snapshot message", () => {
      const msg = expectOk(
        JSON.stringify({ type: "get_session_snapshot", sessionId: "s1", targetSessionId: "s2" }),
      );
      expect(msg.type).toBe("get_session_snapshot");
      if (msg.type === "get_session_snapshot") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.targetSessionId).toBe("s2");
      }
    });

    test("get_session_snapshot validates required fields", () => {
      expect(expectErr(JSON.stringify({ type: "get_session_snapshot", targetSessionId: "s2" }))).toBe(
        "get_session_snapshot missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "get_session_snapshot", sessionId: "s1" }))).toBe(
        "get_session_snapshot missing/invalid targetSessionId",
      );
      expect(
        expectErr(JSON.stringify({ type: "get_session_snapshot", sessionId: "s1", targetSessionId: "" })),
      ).toBe("get_session_snapshot missing/invalid targetSessionId");
    });
  });

  describe("delete_session", () => {
    test("valid delete_session message", () => {
      const msg = expectOk(
        JSON.stringify({ type: "delete_session", sessionId: "s1", targetSessionId: "s2" }),
      );
      expect(msg.type).toBe("delete_session");
      if (msg.type === "delete_session") {
        expect(msg.targetSessionId).toBe("s2");
      }
    });

    test("delete_session missing fields fail", () => {
      expect(expectErr(JSON.stringify({ type: "delete_session", targetSessionId: "s2" }))).toBe(
        "delete_session missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "delete_session", sessionId: "s1" }))).toBe(
        "delete_session missing/invalid targetSessionId",
      );
      expect(
        expectErr(JSON.stringify({ type: "delete_session", sessionId: "s1", targetSessionId: "" })),
      ).toBe("delete_session missing/invalid targetSessionId");
    });
  });

  describe("child-agent messages", () => {
    test("valid agent_spawn message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "agent_spawn",
          sessionId: "s1",
          role: "worker",
          message: "Investigate this",
          model: "gpt-5.4",
          reasoningEffort: "high",
          forkContext: true,
        }),
      );
      expect(msg.type).toBe("agent_spawn");
      if (msg.type === "agent_spawn") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.role).toBe("worker");
        expect(msg.message).toBe("Investigate this");
        expect(msg.model).toBe("gpt-5.4");
        expect(msg.reasoningEffort).toBe("high");
        expect(msg.forkContext).toBe(true);
      }
    });

    test("agent_spawn validates message and optional role", () => {
      expect(expectErr(JSON.stringify({ type: "agent_spawn", sessionId: "s1", message: "" }))).toBe(
        "agent_spawn missing/invalid message",
      );
      expect(expectErr(JSON.stringify({ type: "agent_spawn", sessionId: "s1", role: "invalid", message: "do it" }))).toBe(
        "agent_spawn invalid role",
      );
    });

    test("valid agent lifecycle messages", () => {
      const input = expectOk(JSON.stringify({
        type: "agent_input_send",
        sessionId: "s1",
        agentId: "child-1",
        message: "continue",
        interrupt: true,
      }));
      expect(input.type).toBe("agent_input_send");
      if (input.type === "agent_input_send") {
        expect(input.agentId).toBe("child-1");
        expect(input.message).toBe("continue");
        expect(input.interrupt).toBe(true);
      }

      const wait = expectOk(JSON.stringify({
        type: "agent_wait",
        sessionId: "s1",
        agentIds: ["child-1", "child-2"],
        timeoutMs: 50,
      }));
      expect(wait.type).toBe("agent_wait");
      if (wait.type === "agent_wait") {
        expect(wait.agentIds).toEqual(["child-1", "child-2"]);
        expect(wait.timeoutMs).toBe(50);
      }

      const resume = expectOk(JSON.stringify({ type: "agent_resume", sessionId: "s1", agentId: "child-1" }));
      expect(resume.type).toBe("agent_resume");

      const close = expectOk(JSON.stringify({ type: "agent_close", sessionId: "s1", agentId: "child-1" }));
      expect(close.type).toBe("agent_close");
    });

    test("agent lifecycle messages validate required fields", () => {
      expect(expectErr(JSON.stringify({ type: "agent_input_send", sessionId: "s1", agentId: "child-1" }))).toBe(
        "agent_input_send missing/invalid message",
      );
      expect(expectErr(JSON.stringify({ type: "agent_wait", sessionId: "s1", agentIds: [] }))).toBe(
        "agent_wait missing/invalid agentIds",
      );
      expect(expectErr(JSON.stringify({ type: "agent_resume", sessionId: "s1" }))).toBe(
        "agent_resume missing/invalid agentId",
      );
      expect(expectErr(JSON.stringify({ type: "agent_close", sessionId: "s1" }))).toBe(
        "agent_close missing/invalid agentId",
      );
    });

    test("valid agent_list_get message", () => {
      const msg = expectOk(JSON.stringify({ type: "agent_list_get", sessionId: "s1" }));
      expect(msg.type).toBe("agent_list_get");
      if (msg.type === "agent_list_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });
  });

  describe("set_config", () => {
    test("valid set_config accepts partial config", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            yolo: true,
            observabilityEnabled: false,
            backupsEnabled: true,
            toolOutputOverflowChars: null,
            preferredChildModel: "gpt-5.2",
            maxSteps: 25,
            providerOptions: {
              openai: {
                reasoningEffort: "xhigh",
                reasoningSummary: "concise",
                textVerbosity: "medium",
              },
            },
          },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.yolo).toBe(true);
        expect(msg.config.observabilityEnabled).toBe(false);
        expect(msg.config.backupsEnabled).toBe(true);
        expect(msg.config.toolOutputOverflowChars).toBeNull();
        expect(msg.config.preferredChildModel).toBe("gpt-5.2");
        expect(msg.config.childModelRoutingMode).toBeUndefined();
        expect(msg.config.maxSteps).toBe(25);
        expect(msg.config.providerOptions?.openai?.reasoningEffort).toBe("xhigh");
        expect(msg.config.providerOptions?.openai?.reasoningSummary).toBe("concise");
        expect(msg.config.providerOptions?.openai?.textVerbosity).toBe("medium");
      }
    });

    test("valid set_config accepts cross-provider child routing fields", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            childModelRoutingMode: "cross-provider-allowlist",
            preferredChildModelRef: "opencode-zen:glm-5",
            allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
          },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.childModelRoutingMode).toBe("cross-provider-allowlist");
        expect(msg.config.preferredChildModelRef).toBe("opencode-zen:glm-5");
        expect(msg.config.allowedChildModelRefs).toEqual(["opencode-zen:glm-5", "opencode-go:glm-5"]);
      }
    });

    test("valid set_config accepts codex native web search provider options", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            providerOptions: {
              "codex-cli": {
                reasoningEffort: "high",
                webSearchBackend: "native",
                webSearchMode: "live",
                webSearch: {
                  contextSize: "medium",
                  allowedDomains: ["openai.com", "docs.example.com"],
                  location: {
                    country: "US",
                    region: "NY",
                    city: "New York",
                    timezone: "America/New_York",
                  },
                },
              },
            },
          },
        }),
      );

      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.providerOptions?.["codex-cli"]).toEqual({
          reasoningEffort: "high",
          webSearchBackend: "native",
          webSearchMode: "live",
          webSearch: {
            contextSize: "medium",
            allowedDomains: ["openai.com", "docs.example.com"],
            location: {
              country: "US",
              region: "NY",
              city: "New York",
              timezone: "America/New_York",
            },
          },
        });
      }
    });

    test("valid set_config accepts lmstudio provider options", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            providerOptions: {
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234",
                contextLength: 16384,
                autoLoad: false,
                reloadOnContextMismatch: true,
              },
            },
          },
        }),
      );

      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.providerOptions?.lmstudio).toEqual({
          baseUrl: "http://127.0.0.1:1234",
          contextLength: 16384,
          autoLoad: false,
          reloadOnContextMismatch: true,
        });
      }
    });

    test("valid set_config accepts Gemini native tool provider options", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            providerOptions: {
              google: {
                nativeWebSearch: true,
                thinkingConfig: {
                  thinkingLevel: "minimal",
                },
              },
            },
          },
        }),
      );

      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.providerOptions?.google).toEqual({
          nativeWebSearch: true,
          thinkingConfig: {
            thinkingLevel: "minimal",
          },
        });
      }
    });

    test("valid set_config accepts clearToolOutputOverflowChars", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            clearToolOutputOverflowChars: true,
          },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.clearToolOutputOverflowChars).toBe(true);
      }
    });

    test("set_config validates field types and ranges", () => {
      expect(expectErr(JSON.stringify({ type: "set_config", config: {} }))).toBe(
        "set_config missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "set_config", sessionId: "s1" }))).toBe(
        "set_config missing/invalid config",
      );
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { yolo: "yes" } })),
      ).toBe("set_config config.yolo must be boolean");
      expect(
        expectErr(
          JSON.stringify({ type: "set_config", sessionId: "s1", config: { observabilityEnabled: "no" } }),
        ),
      ).toBe("set_config config.observabilityEnabled must be boolean");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { backupsEnabled: "no" } })),
      ).toBe("set_config config.backupsEnabled must be boolean");
      expect(
        expectErr(
          JSON.stringify({ type: "set_config", sessionId: "s1", config: { toolOutputOverflowChars: -1 } }),
        ),
      ).toBe("set_config config.toolOutputOverflowChars must be null or non-negative integer");
      expect(
        expectErr(
          JSON.stringify({ type: "set_config", sessionId: "s1", config: { clearToolOutputOverflowChars: "yes" } }),
        ),
      ).toBe("set_config config.clearToolOutputOverflowChars must be boolean");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { webSearchBackend: "google" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.webSearchBackend must be one of native, exa");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { toolOutputOverflowChars: 25000, clearToolOutputOverflowChars: true },
          }),
        ),
      ).toBe("set_config config.toolOutputOverflowChars cannot be combined with clearToolOutputOverflowChars");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { preferredChildModel: "" } })),
      ).toBe("set_config config.preferredChildModel must be non-empty string");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { childModelRoutingMode: "cross-provider" } })),
      ).toBe("set_config config.childModelRoutingMode must be one of same-provider, cross-provider-allowlist");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { preferredChildModelRef: "" } })),
      ).toBe("set_config config.preferredChildModelRef must be non-empty string");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { allowedChildModelRefs: [""] } })),
      ).toBe("set_config config.allowedChildModelRefs must be an array of non-empty strings");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { maxSteps: 0 } })),
      ).toBe("set_config config.maxSteps must be number 1-1000");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { maxSteps: 1001 } })),
      ).toBe("set_config config.maxSteps must be number 1-1000");
      expect(
        expectErr(JSON.stringify({ type: "set_config", sessionId: "s1", config: { providerOptions: "nope" } })),
      ).toBe("set_config config.providerOptions must be an object");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { anthropic: { reasoningEffort: "high" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions only supports openai, codex-cli, aws-bedrock-proxy, google, and lmstudio");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { openai: { unsupported: true } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.openai only supports reasoningEffort, reasoningSummary, and textVerbosity");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { openai: { reasoningEffort: "max" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.openai.reasoningEffort must be one of none, low, medium, high, xhigh");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { openai: { reasoningSummary: "verbose" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.openai.reasoningSummary must be one of auto, concise, detailed");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { textVerbosity: "verbose" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.textVerbosity must be one of low, medium, high");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { webSearchMode: "internet" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.webSearchMode must be one of disabled, cached, live");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { webSearch: { unsupported: true } } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.webSearch only supports contextSize, allowedDomains, and location");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { webSearch: { allowedDomains: ["", "openai.com"] } } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.webSearch.allowedDomains must be an array of non-empty strings");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { "codex-cli": { webSearch: { location: { country: "" } } } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.codex-cli.webSearch.location.country must be a non-empty string");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { lmstudio: { unsupported: true } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.lmstudio only supports baseUrl, contextLength, autoLoad, and reloadOnContextMismatch");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { lmstudio: { contextLength: 0 } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.lmstudio.contextLength must be a positive integer");
      expect(
        expectErr(
          JSON.stringify({
            type: "set_config",
            sessionId: "s1",
            config: { providerOptions: { lmstudio: { autoLoad: "yes" } } },
          }),
        ),
      ).toBe("set_config config.providerOptions.lmstudio.autoLoad must be boolean");
    });

    test("set_config accepts userName with non-empty string", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: { userName: "Alice" },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.userName).toBe("Alice");
      }
    });

    test("set_config accepts empty userName to clear the field", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: { userName: "" },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.userName).toBe("");
      }
    });

    test("set_config accepts userProfile object", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: {
            userProfile: {
              instructions: "Be concise",
              work: "Software engineer",
              details: "Uses TypeScript",
            },
          },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.userProfile?.instructions).toBe("Be concise");
        expect(msg.config.userProfile?.work).toBe("Software engineer");
        expect(msg.config.userProfile?.details).toBe("Uses TypeScript");
      }
    });

    test("set_config accepts partial userProfile fields", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: { userProfile: { work: "Dev" } },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.userProfile?.work).toBe("Dev");
        expect(msg.config.userProfile?.instructions).toBeUndefined();
        expect(msg.config.userProfile?.details).toBeUndefined();
      }
    });

    test("set_config accepts empty userProfile field strings to clear them", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_config",
          sessionId: "s1",
          config: { userProfile: { instructions: "", work: "", details: "" } },
        }),
      );
      expect(msg.type).toBe("set_config");
      if (msg.type === "set_config") {
        expect(msg.config.userProfile?.instructions).toBe("");
        expect(msg.config.userProfile?.work).toBe("");
        expect(msg.config.userProfile?.details).toBe("");
      }
    });
  });

  describe("upload_file", () => {
    test("valid upload_file message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "upload_file",
          sessionId: "s1",
          filename: "notes.txt",
          contentBase64: "dGVzdA==",
        }),
      );
      expect(msg.type).toBe("upload_file");
      if (msg.type === "upload_file") {
        expect(msg.filename).toBe("notes.txt");
        expect(msg.contentBase64).toBe("dGVzdA==");
      }
    });

    test("upload_file validates required fields", () => {
      expect(expectErr(JSON.stringify({ type: "upload_file", filename: "a.txt", contentBase64: "" }))).toBe(
        "upload_file missing sessionId",
      );
      expect(expectErr(JSON.stringify({ type: "upload_file", sessionId: "s1", contentBase64: "" }))).toBe(
        "upload_file missing/invalid filename",
      );
      expect(
        expectErr(JSON.stringify({ type: "upload_file", sessionId: "s1", filename: "a.txt", contentBase64: 12 })),
      ).toBe("upload_file missing/invalid contentBase64");
    });
  });

  describe("set_session_usage_budget", () => {
    test("get_session_usage parses as a session-scoped request", () => {
      const msg = expectOk(JSON.stringify({ type: "get_session_usage", sessionId: "s1" }));
      expect(msg.type).toBe("get_session_usage");
      if (msg.type === "get_session_usage") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("get_session_usage validates required sessionId", () => {
      expect(expectErr(JSON.stringify({ type: "get_session_usage" }))).toBe("get_session_usage missing sessionId");
    });

    test("valid budget update message", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_session_usage_budget",
          sessionId: "s1",
          warnAtUsd: 1,
          stopAtUsd: null,
        }),
      );
      expect(msg.type).toBe("set_session_usage_budget");
      if (msg.type === "set_session_usage_budget") {
        expect(msg.warnAtUsd).toBe(1);
        expect(msg.stopAtUsd).toBeNull();
      }
    });

    test("accepts zero-dollar budget thresholds", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_session_usage_budget",
          sessionId: "s1",
          stopAtUsd: 0,
        }),
      );
      expect(msg.type).toBe("set_session_usage_budget");
      if (msg.type === "set_session_usage_budget") {
        expect(msg.stopAtUsd).toBe(0);
      }
    });

    test("requires at least one budget field", () => {
      expect(expectErr(JSON.stringify({ type: "set_session_usage_budget", sessionId: "s1" }))).toBe(
        "set_session_usage_budget requires warnAtUsd and/or stopAtUsd",
      );
    });

    test("requires warnAtUsd below stopAtUsd when both are numbers", () => {
      expect(
        expectErr(JSON.stringify({
          type: "set_session_usage_budget",
          sessionId: "s1",
          warnAtUsd: 5,
          stopAtUsd: 5,
        })),
      ).toBe("set_session_usage_budget warnAtUsd must be less than stopAtUsd");
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

    test("workspace_backups_get parses", () => {
      const msg = expectOk(JSON.stringify({ type: "workspace_backups_get", sessionId: "s1" }));
      expect(msg.type).toBe("workspace_backups_get");
      if (msg.type === "workspace_backups_get") {
        expect(msg.sessionId).toBe("s1");
      }
    });

    test("workspace_backup_checkpoint parses", () => {
      const msg = expectOk(
        JSON.stringify({ type: "workspace_backup_checkpoint", sessionId: "s1", targetSessionId: "target-1" }),
      );
      expect(msg.type).toBe("workspace_backup_checkpoint");
      if (msg.type === "workspace_backup_checkpoint") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.targetSessionId).toBe("target-1");
      }
    });

    test("workspace_backup_restore parses original target (no checkpointId)", () => {
      const msg = expectOk(
        JSON.stringify({ type: "workspace_backup_restore", sessionId: "s1", targetSessionId: "target-1" }),
      );
      expect(msg.type).toBe("workspace_backup_restore");
      if (msg.type === "workspace_backup_restore") {
        expect(msg.targetSessionId).toBe("target-1");
        expect(msg.checkpointId).toBeUndefined();
      }
    });

    test("workspace_backup_restore parses checkpoint target", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "workspace_backup_restore",
          sessionId: "s1",
          targetSessionId: "target-1",
          checkpointId: "cp-0001",
        }),
      );
      expect(msg.type).toBe("workspace_backup_restore");
      if (msg.type === "workspace_backup_restore") {
        expect(msg.targetSessionId).toBe("target-1");
        expect(msg.checkpointId).toBe("cp-0001");
      }
    });

    test("workspace_backup_delete_checkpoint parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "workspace_backup_delete_checkpoint",
          sessionId: "s1",
          targetSessionId: "target-1",
          checkpointId: "cp-0001",
        }),
      );
      expect(msg.type).toBe("workspace_backup_delete_checkpoint");
      if (msg.type === "workspace_backup_delete_checkpoint") {
        expect(msg.targetSessionId).toBe("target-1");
        expect(msg.checkpointId).toBe("cp-0001");
      }
    });

    test("workspace_backup_delete_entry parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "workspace_backup_delete_entry",
          sessionId: "s1",
          targetSessionId: "target-1",
        }),
      );
      expect(msg.type).toBe("workspace_backup_delete_entry");
      if (msg.type === "workspace_backup_delete_entry") {
        expect(msg.targetSessionId).toBe("target-1");
      }
    });

    test("workspace_backup_delta_get parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "workspace_backup_delta_get",
          sessionId: "s1",
          targetSessionId: "target-1",
          checkpointId: "cp-0001",
        }),
      );
      expect(msg.type).toBe("workspace_backup_delta_get");
      if (msg.type === "workspace_backup_delta_get") {
        expect(msg.targetSessionId).toBe("target-1");
        expect(msg.checkpointId).toBe("cp-0001");
      }
    });

    test("workspace backup messages validate required targetSessionId/checkpointId fields", () => {
      expect(expectErr(JSON.stringify({ type: "workspace_backup_checkpoint", sessionId: "s1" }))).toContain(
        "workspace_backup_checkpoint missing targetSessionId",
      );
      expect(expectErr(JSON.stringify({ type: "workspace_backup_restore", sessionId: "s1" }))).toContain(
        "workspace_backup_restore missing targetSessionId",
      );
      expect(expectErr(JSON.stringify({ type: "workspace_backup_delete_entry", sessionId: "s1" }))).toContain(
        "workspace_backup_delete_entry missing targetSessionId",
      );
      expect(expectErr(
        JSON.stringify({
          type: "workspace_backup_delete_checkpoint",
          sessionId: "s1",
          targetSessionId: "target-1",
        }),
      )).toContain("workspace_backup_delete_checkpoint missing checkpointId");
      expect(expectErr(JSON.stringify({ type: "workspace_backup_delta_get", sessionId: "s1" }))).toContain(
        "workspace_backup_delta_get missing targetSessionId",
      );
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
      expect(CLIENT_MESSAGE_TYPES.includes("steer_message")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_catalog_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_methods_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("user_config_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("user_config_set")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_authorize")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_logout")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_callback")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_set_api_key")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("provider_auth_copy_api_key")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_servers_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_upsert")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_delete")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_validate")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_auth_authorize")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_auth_callback")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_server_auth_set_api_key")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("mcp_servers_migrate_legacy")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_spawn")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_list_get")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_input_send")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_wait")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_resume")).toBe(true);
      expect(CLIENT_MESSAGE_TYPES.includes("agent_close")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("commands")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_catalog")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_methods")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("user_config")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("user_config_result")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_challenge")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("provider_auth_result")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("mcp_servers")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("steer_accepted")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("mcp_server_validation")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("mcp_server_auth_challenge")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("mcp_server_auth_result")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("session_info")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("session_config")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("agent_spawned")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("agent_list")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("agent_status")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("agent_wait_result")).toBe(true);
      expect(SERVER_EVENT_TYPES.includes("model_stream_chunk")).toBe(true);
    });

    test("server_hello supports protocolVersion", () => {
      const evt: ServerEvent = {
        type: "server_hello",
        sessionId: "s1",
        protocolVersion: "4.0",
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
        expect(evt.protocolVersion).toBe("4.0");
        expect(evt.capabilities?.modelStreamChunk).toBe("v1");
      }
    });

    test("server_hello supports resumed active turn ids", () => {
      const evt = safeParseServerEvent({
        type: "server_hello",
        sessionId: "s1",
        protocolVersion: "7.19",
        busy: true,
        turnId: "turn-1",
        config: {
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp",
        },
      });

      expect(evt?.type).toBe("server_hello");
      if (evt?.type === "server_hello") {
        expect(evt.turnId).toBe("turn-1");
      }
    });

    test("safeParseServerEvent accepts steer_accepted", () => {
      const evt = safeParseServerEvent({
        type: "steer_accepted",
        sessionId: "s1",
        turnId: "turn-1",
        text: "tighten scope",
        clientMessageId: "cm-steer",
      });

      expect(evt).not.toBeNull();
      expect(evt?.type).toBe("steer_accepted");
      if (evt?.type === "steer_accepted") {
        expect(evt.turnId).toBe("turn-1");
        expect(evt.clientMessageId).toBe("cm-steer");
      }
    });

    test("safeParseServerEvent accepts agent_wait_result", () => {
      const evt = safeParseServerEvent({
        type: "agent_wait_result",
        sessionId: "root-1",
        agentIds: ["child-1"],
        timedOut: false,
        agents: [
          {
            agentId: "child-1",
            parentSessionId: "root-1",
            role: "worker",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Done",
            provider: "openai",
            createdAt: "2026-03-16T18:00:00.000Z",
            updatedAt: "2026-03-16T18:01:00.000Z",
            lifecycleState: "active",
            executionState: "completed",
            busy: false,
          },
        ],
      });

      expect(evt).not.toBeNull();
      expect(evt?.type).toBe("agent_wait_result");
    });

    test("safeParseServerEvent accepts session_snapshot", () => {
      const evt = safeParseServerEvent({
        type: "session_snapshot",
        sessionId: "control-1",
        targetSessionId: "target-1",
        snapshot: {
          sessionId: "target-1",
          title: "Snapshot Session",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.4",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          mode: null,
          depth: null,
          nickname: null,
          requestedModel: null,
          effectiveModel: null,
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: null,
          lastMessagePreview: "hello",
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:01.000Z",
          messageCount: 2,
          lastEventSeq: 4,
          feed: [
            {
              id: "item-1",
              kind: "message",
              role: "user",
              ts: "2026-03-19T00:00:00.000Z",
              text: "hello",
            },
          ],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      });

      expect(evt).not.toBeNull();
      expect(evt?.type).toBe("session_snapshot");
    });

    test("safeParseServerEvent accepts installation-based skill manager events", () => {
      const catalogEvt = safeParseServerEvent({
        type: "skills_catalog",
        sessionId: "control-1",
        catalog: {
          scopes: [],
          effectiveSkills: [],
          installations: [],
        },
        mutationBlocked: false,
        clearedMutationPendingKeys: ["install:project"],
      });
      expect(catalogEvt).not.toBeNull();
      expect(catalogEvt?.type).toBe("skills_catalog");
      if (catalogEvt?.type === "skills_catalog") {
        expect(catalogEvt.clearedMutationPendingKeys).toEqual(["install:project"]);
      }

      const installationEvt = safeParseServerEvent({
        type: "skill_installation",
        sessionId: "control-1",
        installation: null,
        content: null,
      });
      expect(installationEvt).not.toBeNull();
      expect(installationEvt?.type).toBe("skill_installation");

      const previewEvt = safeParseServerEvent({
        type: "skill_install_preview",
        sessionId: "control-1",
        preview: {
          source: { kind: "github_repo", raw: "openai/skills", displaySource: "https://github.com/openai/skills" },
          targetScope: "project",
          candidates: [],
          warnings: [],
        },
      });
      expect(previewEvt).not.toBeNull();
      expect(previewEvt?.type).toBe("skill_install_preview");

      const updateCheckEvt = safeParseServerEvent({
        type: "skill_installation_update_check",
        sessionId: "control-1",
        result: {
          installationId: "inst-1",
          canUpdate: true,
        },
      });
      expect(updateCheckEvt).not.toBeNull();
      expect(updateCheckEvt?.type).toBe("skill_installation_update_check");
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
