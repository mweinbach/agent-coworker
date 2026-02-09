import { describe, expect, test } from "bun:test";
import { safeParseClientMessage } from "../src/server/protocol";

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

    test.each(["gemini-cli", "codex-cli", "claude-code"])(
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

    test("set_model with empty model still parses", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "set_model",
          sessionId: "s1",
          model: "",
        }),
      );
      if (msg.type === "set_model") {
        expect(msg.model).toBe("");
      }
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

  describe("connect_provider", () => {
    test("valid connect_provider with api key", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "connect_provider",
          sessionId: "s1",
          provider: "openai",
          apiKey: "sk-test",
        })
      );
      expect(msg.type).toBe("connect_provider");
      if (msg.type === "connect_provider") {
        expect(msg.sessionId).toBe("s1");
        expect(msg.provider).toBe("openai");
        expect(msg.apiKey).toBe("sk-test");
      }
    });

    test("valid connect_provider without api key", () => {
      const msg = expectOk(
        JSON.stringify({
          type: "connect_provider",
          sessionId: "s1",
          provider: "codex-cli",
        })
      );
      if (msg.type === "connect_provider") {
        expect(msg.provider).toBe("codex-cli");
        expect(msg.apiKey).toBeUndefined();
      }
    });

    test.each(["gemini-cli", "codex-cli", "claude-code"])(
      "connect_provider accepts %s provider",
      (provider) => {
        const msg = expectOk(
          JSON.stringify({
            type: "connect_provider",
            sessionId: "s1",
            provider,
          })
        );
        if (msg.type === "connect_provider") {
          expect(msg.provider).toBe(provider);
        }
      }
    );

    test("connect_provider missing sessionId fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "connect_provider",
          provider: "openai",
          apiKey: "sk-test",
        })
      );
      expect(err).toContain("connect_provider missing sessionId");
    });

    test("connect_provider with invalid provider fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "connect_provider",
          sessionId: "s1",
          provider: "not-real",
        })
      );
      expect(err).toContain("connect_provider missing/invalid provider");
    });

    test("connect_provider with non-string apiKey fails", () => {
      const err = expectErr(
        JSON.stringify({
          type: "connect_provider",
          sessionId: "s1",
          provider: "openai",
          apiKey: 123,
        })
      );
      expect(err).toContain("connect_provider invalid apiKey");
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
      expect(err).toBe("read_skill missing skillName");
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
      expect(expectErr(JSON.stringify({ type: "disable_skill", sessionId: "s1" }))).toBe("disable_skill missing skillName");
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
      expect(expectErr(JSON.stringify({ type: "enable_skill", sessionId: "s1" }))).toBe("enable_skill missing skillName");
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
      expect(expectErr(JSON.stringify({ type: "delete_skill", sessionId: "s1" }))).toBe("delete_skill missing skillName");
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
      // Arrays pass typeof === "object" && !== null, so they reach the type check
      const err = expectErr('[{"type":"reset"}]');
      expect(err).toBe("Missing type");
    });

    test("JSON empty array", () => {
      const err = expectErr("[]");
      expect(err).toBe("Missing type");
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
