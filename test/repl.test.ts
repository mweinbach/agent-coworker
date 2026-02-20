import { describe, expect, test, mock, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as replInternal } from "../src/cli/repl";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeTmpDir(prefix = "repl-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function resolveAndValidateDir(dirArg: string): Promise<string> {
  return await replInternal.resolveAndValidateDir(dirArg);
}

describe("resolveAndValidateDir", () => {
  test("resolves a valid directory to its absolute path", async () => {
    const tmp = await makeTmpDir();
    const result = await resolveAndValidateDir(tmp);
    expect(result).toBe(path.resolve(tmp));
  });

  test("resolves a relative path to an absolute path", async () => {
    // os.tmpdir() is absolute, so use it as the base
    const tmp = await makeTmpDir();
    const relative = path.relative(process.cwd(), tmp);
    const result = await resolveAndValidateDir(relative);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve(relative));
  });

  test("throws for a non-existent directory", async () => {
    const bogus = path.join(os.tmpdir(), "does-not-exist-repl-test-99999");
    try {
      await resolveAndValidateDir(bogus);
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("--dir is not a directory");
      expect(err.message).toContain(bogus);
    }
  });

  test("throws when path points to a file instead of a directory", async () => {
    const tmp = await makeTmpDir();
    const filePath = path.join(tmp, "afile.txt");
    await fs.writeFile(filePath, "hello", "utf-8");
    try {
      await resolveAndValidateDir(filePath);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("--dir is not a directory");
    }
  });

  test("accepts the current working directory expressed as '.'", async () => {
    // path.resolve('.') is process.cwd()
    const result = await resolveAndValidateDir(".");
    expect(result).toBe(process.cwd());
  });

  test("accepts a nested subdirectory", async () => {
    const tmp = await makeTmpDir();
    const nested = path.join(tmp, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    const result = await resolveAndValidateDir(nested);
    expect(result).toBe(nested);
  });
});

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

function renderTodosToLines(todos: TodoItem[]): string[] {
  return replInternal.renderTodosToLines(todos);
}

function renderToolsToLines(tools: any[]): string[] {
  return replInternal.renderToolsToLines(tools as any);
}

describe("renderTodos", () => {
  test("returns empty for empty todos list", () => {
    const lines = renderTodosToLines([]);
    expect(lines).toEqual([]);
  });

  test("renders a single pending todo with - icon", () => {
    const lines = renderTodosToLines([
      { content: "Do thing", status: "pending", activeForm: "Doing thing" },
    ]);
    expect(lines).toContain("  - Do thing");
  });

  test("renders a single in_progress todo with > icon", () => {
    const lines = renderTodosToLines([
      { content: "Coding", status: "in_progress", activeForm: "Writing code" },
    ]);
    expect(lines).toContain("  > Coding");
  });

  test("renders a single completed todo with x icon", () => {
    const lines = renderTodosToLines([
      { content: "Done task", status: "completed", activeForm: "Finishing" },
    ]);
    expect(lines).toContain("  x Done task");
  });

  test("includes Progress header", () => {
    const lines = renderTodosToLines([
      { content: "A", status: "pending", activeForm: "Doing A" },
    ]);
    expect(lines[0]).toBe("\n--- Progress ---");
  });

  test("shows activeForm of in_progress item", () => {
    const lines = renderTodosToLines([
      { content: "Build", status: "in_progress", activeForm: "Building the widget" },
    ]);
    const activeLine = lines.find((l) => l.includes("Building the widget"));
    expect(activeLine).toBeDefined();
    expect(activeLine).toContain("...");
  });

  test("does not show activeForm when no in_progress item", () => {
    const lines = renderTodosToLines([
      { content: "Done", status: "completed", activeForm: "Finishing" },
      { content: "Waiting", status: "pending", activeForm: "Getting ready" },
    ]);
    const activeLines = lines.filter((l) => l.includes("Finishing") || l.includes("Getting ready"));
    // The activeForm line format is "\n  {activeForm}..." which only appears for in_progress
    const formattedActive = lines.filter((l) => l.includes("..."));
    expect(formattedActive).toEqual([]);
  });

  test("renders multiple todos in order", () => {
    const todos: TodoItem[] = [
      { content: "Step 1", status: "completed", activeForm: "Doing 1" },
      { content: "Step 2", status: "in_progress", activeForm: "Doing 2" },
      { content: "Step 3", status: "pending", activeForm: "Doing 3" },
    ];
    const lines = renderTodosToLines(todos);
    const step1Idx = lines.findIndex((l) => l.includes("Step 1"));
    const step2Idx = lines.findIndex((l) => l.includes("Step 2"));
    const step3Idx = lines.findIndex((l) => l.includes("Step 3"));
    expect(step1Idx).toBeLessThan(step2Idx);
    expect(step2Idx).toBeLessThan(step3Idx);
  });

  test("renders correct icons for mixed statuses", () => {
    const todos: TodoItem[] = [
      { content: "A", status: "completed", activeForm: "Aa" },
      { content: "B", status: "in_progress", activeForm: "Bb" },
      { content: "C", status: "pending", activeForm: "Cc" },
    ];
    const lines = renderTodosToLines(todos);
    expect(lines).toContain("  x A");
    expect(lines).toContain("  > B");
    expect(lines).toContain("  - C");
  });
});

describe("renderToolsToLines", () => {
  test("renders tool objects as name and description", () => {
    const lines = renderToolsToLines([
      { name: "bash", description: "Execute a shell command" },
      { name: "read", description: "read" },
    ]);
    expect(lines).toEqual([
      "  - bash: Execute a shell command",
      "  - read",
    ]);
  });

  test("renders legacy string tool entries", () => {
    const lines = renderToolsToLines(["bash", "read"]);
    expect(lines).toEqual(["  - bash", "  - read"]);
  });
});

function parseReplInput(input: string) {
  return replInternal.parseReplInput(input);
}

function normalizeProviderAuthMethods(methods: any[] | undefined) {
  return replInternal.normalizeProviderAuthMethods(methods as any);
}

function resolveProviderAuthMethodSelection(methods: any[], rawSelection: string) {
  return replInternal.resolveProviderAuthMethodSelection(methods as any, rawSelection);
}

describe("REPL command parsing", () => {
  test("/help is parsed as help command", () => {
    expect(parseReplInput("/help")).toEqual({ type: "help" });
  });

  test("/exit is parsed as exit command", () => {
    expect(parseReplInput("/exit")).toEqual({ type: "exit" });
  });

  test("/new is parsed as new command", () => {
    expect(parseReplInput("/new")).toEqual({ type: "new" });
  });

  test("/restart is parsed as restart command", () => {
    expect(parseReplInput("/restart")).toEqual({ type: "restart" });
  });

  test("/model with id is parsed correctly", () => {
    const result = parseReplInput("/model gpt-4o");
    expect(result.type).toBe("model");
    expect(result.arg).toBe("gpt-4o");
  });

  test("/model without id returns empty arg", () => {
    const result = parseReplInput("/model");
    expect(result.type).toBe("model");
    expect(result.arg).toBe("");
  });

  test("/provider with valid name is parsed", () => {
    const result = parseReplInput("/provider google");
    expect(result.type).toBe("provider");
    expect(result.arg).toBe("google");
  });

  test("/connect with provider and key is parsed", () => {
    const result = parseReplInput("/connect openai sk-test");
    expect(result.type).toBe("connect");
    expect(result.arg).toBe("openai sk-test");
  });

  test("/connect with only provider is parsed", () => {
    const result = parseReplInput("/connect codex-cli");
    expect(result.type).toBe("connect");
    expect(result.arg).toBe("codex-cli");
  });

  test("/cwd with path is parsed", () => {
    const result = parseReplInput("/cwd /tmp/mydir");
    expect(result.type).toBe("cwd");
    expect(result.arg).toBe("/tmp/mydir");
  });

  test("/tools is parsed as tools command", () => {
    expect(parseReplInput("/tools")).toEqual({ type: "tools" });
  });

  test("/sessions is parsed as sessions command", () => {
    expect(parseReplInput("/sessions")).toEqual({ type: "sessions" });
  });

  test("/resume with id is parsed correctly", () => {
    const result = parseReplInput("/resume abc123");
    expect(result.type).toBe("resume");
    if (result.type === "resume") {
      expect(result.arg).toBe("abc123");
    }
  });

  test("unknown slash command is parsed as unknown", () => {
    const result = parseReplInput("/foobar");
    expect(result.type).toBe("unknown");
    if (result.type === "unknown") {
      expect(result.name).toBe("foobar");
      expect(result.arg).toBe("");
    }
  });

  test("regular text is parsed as message", () => {
    const result = parseReplInput("hello world");
    expect(result.type).toBe("message");
    expect(result.arg).toBe("hello world");
  });

  test("empty input is parsed as message with empty arg", () => {
    const result = parseReplInput("");
    expect(result.type).toBe("message");
    expect(result.arg).toBe("");
  });

  test("whitespace-only input is parsed as message with empty arg", () => {
    const result = parseReplInput("   ");
    expect(result.type).toBe("message");
    expect(result.arg).toBe("");
  });

  test("/model with multi-word id joins correctly", () => {
    const result = parseReplInput("/model my custom model");
    expect(result.type).toBe("model");
    expect(result.arg).toBe("my custom model");
  });

  test("/cwd with path containing spaces joins correctly", () => {
    const result = parseReplInput("/cwd /path/with spaces/dir");
    expect(result.type).toBe("cwd");
    expect(result.arg).toBe("/path/with spaces/dir");
  });

  // TODO: Integration tests that start runCliRepl with mocked readline and
  // verify actual console output are difficult because runCliRepl:
  //   1. Calls loadConfig which reads real filesystem config
  //   2. Creates directories (projectAgentDir, outputDirectory, uploadsDirectory)
  //   3. Binds to process.stdin via readline
  //
  // A full integration test would require mock.module() for:
  //   - "../config" (loadConfig, defaultModelForProvider)
  //   - "../agent" (runTurn)
  //   - "../prompt" (loadSystemPrompt)
  //   - "../tools" (createTools)
  //   - "node:readline" (createInterface)
  //
  // This is deferred as it requires significant setup and the command parsing
  // and helper logic is well-covered by the replicated unit tests above.
});

describe("connect auth method helpers", () => {
  test("normalizeProviderAuthMethods falls back to api_key", () => {
    const methods = normalizeProviderAuthMethods(undefined);
    expect(methods).toEqual([{ id: "api_key", type: "api", label: "API key" }]);
  });

  test("normalizeProviderAuthMethods preserves provided methods", () => {
    const methods = normalizeProviderAuthMethods([
      { id: "oauth_cli", type: "oauth", label: "Sign in", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ]);
    expect(methods).toHaveLength(2);
    expect(methods[0]?.id).toBe("oauth_cli");
  });

  test("resolveProviderAuthMethodSelection defaults to first method", () => {
    const selected = resolveProviderAuthMethodSelection(
      [
        { id: "oauth_cli", type: "oauth", label: "Sign in", oauthMode: "auto" },
        { id: "api_key", type: "api", label: "API key" },
      ],
      ""
    );
    expect(selected?.id).toBe("oauth_cli");
  });

  test("resolveProviderAuthMethodSelection accepts numeric index", () => {
    const selected = resolveProviderAuthMethodSelection(
      [
        { id: "oauth_cli", type: "oauth", label: "Sign in", oauthMode: "auto" },
        { id: "api_key", type: "api", label: "API key" },
      ],
      "2"
    );
    expect(selected?.id).toBe("api_key");
  });

  test("resolveProviderAuthMethodSelection accepts method id", () => {
    const selected = resolveProviderAuthMethodSelection(
      [
        { id: "oauth_cli", type: "oauth", label: "Sign in", oauthMode: "auto" },
        { id: "api_key", type: "api", label: "API key" },
      ],
      "api_key"
    );
    expect(selected?.id).toBe("api_key");
  });

  test("resolveProviderAuthMethodSelection rejects invalid selections", () => {
    const selected = resolveProviderAuthMethodSelection(
      [
        { id: "oauth_cli", type: "oauth", label: "Sign in", oauthMode: "auto" },
        { id: "api_key", type: "api", label: "API key" },
      ],
      "unknown"
    );
    expect(selected).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAskAnswer (real implementation from repl.ts via __internal)
// ---------------------------------------------------------------------------
describe("resolveAskAnswer", () => {
  const resolveAskAnswer = replInternal.resolveAskAnswer;

  test("returns option by 1-based index '1'", () => {
    expect(resolveAskAnswer("1", ["apple", "banana"])).toBe("apple");
  });

  test("returns option by 1-based index '2'", () => {
    expect(resolveAskAnswer("2", ["apple", "banana"])).toBe("banana");
  });

  test("returns raw string when index '0' is out of range", () => {
    expect(resolveAskAnswer("0", ["apple"])).toBe("0");
  });

  test("returns raw string for non-numeric input with options", () => {
    expect(resolveAskAnswer("yes", ["apple"])).toBe("yes");
  });

  test("returns raw string '1' when no options are provided", () => {
    expect(resolveAskAnswer("1")).toBe("1");
  });

  test("returns empty string for empty input", () => {
    expect(resolveAskAnswer("")).toBe("");
  });

  test("returns trimmed text when no options", () => {
    expect(resolveAskAnswer("  hello  ")).toBe("hello");
  });

  test("returns raw text when number is out of range (too high)", () => {
    expect(resolveAskAnswer("5", ["a", "b"])).toBe("5");
  });

  test("returns raw text when number is negative", () => {
    expect(resolveAskAnswer("-1", ["a", "b"])).toBe("-1");
  });

  test("returns raw text when options array is empty", () => {
    expect(resolveAskAnswer("1", [])).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// normalizeApprovalAnswer (real implementation from repl.ts via __internal)
// ---------------------------------------------------------------------------
describe("normalizeApprovalAnswer", () => {
  const normalizeApprovalAnswer = replInternal.normalizeApprovalAnswer;

  test("'y' returns true", () => {
    expect(normalizeApprovalAnswer("y")).toBe(true);
  });

  test("'yes' returns true", () => {
    expect(normalizeApprovalAnswer("yes")).toBe(true);
  });

  test("'approve' returns true", () => {
    expect(normalizeApprovalAnswer("approve")).toBe(true);
  });

  test("'n' returns false", () => {
    expect(normalizeApprovalAnswer("n")).toBe(false);
  });

  test("'no' returns false", () => {
    expect(normalizeApprovalAnswer("no")).toBe(false);
  });

  test("'deny' returns false", () => {
    expect(normalizeApprovalAnswer("deny")).toBe(false);
  });

  test("empty string returns false", () => {
    expect(normalizeApprovalAnswer("")).toBe(false);
  });

  test("'maybe' returns false", () => {
    expect(normalizeApprovalAnswer("maybe")).toBe(false);
  });

  test("case insensitive: 'YES' returns true", () => {
    expect(normalizeApprovalAnswer("YES")).toBe(true);
  });

  test("case insensitive: 'NO' returns false", () => {
    expect(normalizeApprovalAnswer("NO")).toBe(false);
  });

  test("'approved' returns true", () => {
    expect(normalizeApprovalAnswer("approved")).toBe(true);
  });

  test("'denied' returns false", () => {
    expect(normalizeApprovalAnswer("denied")).toBe(false);
  });

  test("whitespace-padded 'y' returns true", () => {
    expect(normalizeApprovalAnswer("  y  ")).toBe(true);
  });
});
