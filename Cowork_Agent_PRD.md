# Cowork Agent — Product Requirements Document

An open-source, model-agnostic coworker agent built on Bun + TypeScript with a websocket-first server and thin TUI/CLI clients.

**Version:** 1.0
**Date:** February 2026

---

## 1. Overview

This PRD is now aligned to the implemented `agent-coworker` architecture in this repository (Bun + TypeScript, websocket-first server, thin TUI/CLI clients, MCP integration, observability + harness, and session backup).

The project goal is release-readiness and behavioral safety for the existing product surface, with additive protocol evolution only.

### 1.1 Design Principles

- **Websocket-first core:** business logic lives in `src/server/session.ts`; clients are transport/rendering layers.
- **Thin clients:** `src/tui/index.tsx` and `src/cli/repl.ts` consume `ServerEvent` and emit `ClientMessage` only.
- **Provider-runtime flexibility:** model/provider switching is runtime-configurable (`connect_provider`, `set_model`) without restarting the server.
- **Safety-first execution:** command approval, path permissions, and explicit risky-action handling remain mandatory defaults.
- **Observability for operations:** local OTEL + query APIs + harness checks are first-class runtime controls, not post-hoc add-ons.
- **Resilience and continuity:** per-session backup/checkpoint/restore is part of core behavior.

### 1.2 Tech Stack

| Layer | Current Implementation |
|---|---|
| Runtime | Bun + TypeScript (ESM, strict mode) |
| Core loop | AI SDK-driven tool loop in `src/agent.ts` |
| Server transport | WebSocket server in `src/server/startServer.ts` |
| Session orchestration | `src/server/session.ts` |
| Protocol contract | `src/server/protocol.ts` + `docs/websocket-protocol.md` |
| Clients | OpenTUI React client (`src/tui/index.tsx`), CLI REPL (`src/cli/repl.ts`) |
| Providers | `google`, `openai`, `anthropic`, `gemini-cli`, `codex-cli`, `claude-code` |
| MCP | Runtime-discovered and namespaced via `src/mcp/index.ts` |
| Observability/Harness | `src/observability/*`, `src/harness/contextStore.ts`, `docs/harness/index.md` |
| Continuity | Session backup/checkpoints in `src/server/sessionBackup.ts` |

### 1.3 Implementation Status vs PRD

| Area | Status | Notes |
|---|---|---|
| Websocket server + per-connection session lifecycle | `implemented` | `startServer` creates `AgentSession`, emits `server_hello`, settings, observability status. |
| Thin TUI/CLI consuming server protocol | `implemented` | UI logic is protocol-driven; server holds business logic. |
| Provider runtime switching (`connect_provider`, `set_model`) | `implemented` | Works across API-key and CLI OAuth provider modes. |
| MCP lifecycle + namespacing + enable/disable at runtime | `implemented with divergence` | More complete than original PRD baseline; includes dynamic lifecycle controls. |
| Observability + harness query/evaluation surface | `implemented with divergence` | Added after original baseline; now part of public API surface. |
| Session backup/checkpoint/restore/delete | `implemented with divergence` | Not in initial baseline; now integrated into core session behavior. |
| Approval gating for risky commands | `implemented` | Command classifier + approval event flow are active. |
| Structured protocol error codes/sources | `implemented` | Additive `error.code`/`error.source` fields introduced for deterministic handling. |
| Protocol version field (`server_hello.protocolVersion`) | `implemented` | Additive handshake metadata introduced. |
| Protocol-doc parity regression checks | `implemented` | Integration tests verify docs headings and executable flows. |
| Typed approval risk codes across all risky actions | `planned` | Incremental hardening work remains for broader policy coverage. |
| Concurrency stress suite (5 parallel sessions mixed traffic) | `pending` | Planned for reliability sprint milestone. |

### 1.4 Legacy Assumptions (Historical)

The following earlier PRD assumptions are retained as historical context, not current architecture:

- CLI-only or “UI later” framing is obsolete; websocket + TUI/CLI clients are shipped.
- Vercel AI SDK examples showing single-process interactive loops are historical; production path is `AgentSession` over websocket.
- Minimal dependency assumptions changed: observability, harness, backup, provider status, and MCP lifecycle expanded the system surface.

---

## 2. Architecture

### 2.1 Project Structure

```text
agent-coworker/
├── src/
│   ├── agent.ts
│   ├── config.ts
│   ├── types.ts
│   ├── server/
│   │   ├── startServer.ts
│   │   ├── session.ts
│   │   ├── protocol.ts
│   │   └── sessionBackup.ts
│   ├── cli/
│   │   ├── args.ts
│   │   └── repl.ts
│   ├── tui/
│   │   └── index.tsx
│   ├── providers/
│   ├── mcp/
│   ├── tools/
│   ├── observability/
│   ├── harness/
│   ├── skills/
│   └── utils/
├── config/
├── docs/
│   ├── websocket-protocol.md
│   └── harness/index.md
└── test/
```

### 2.2 Runtime Topology

1. `startAgentServer()` loads config + prompt + discovered skills.
2. Each websocket connection gets one `AgentSession` instance.
3. Server emits `server_hello`, `session_settings`, and `observability_status` immediately.
4. Client sends `ClientMessage` payloads; server validates with `safeParseClientMessage()`.
5. Session routes messages to provider/runtime/tool execution, MCP, harness, and backup subsystems.
6. Session emits protocol events (`ServerEvent`) that all clients consume uniformly.

### 2.3 Model Configuration

Model/provider behavior is runtime-configurable and no longer tied to static boot-time examples.

- Provider set: `google`, `openai`, `anthropic`, `gemini-cli`, `codex-cli`, `claude-code`.
- Default models are defined in `src/providers/catalog.ts` and resolved per provider.
- Config resolution is layered (`config/defaults.json` → `~/.agent/config.json` → `<cwd>/.agent/config.json` → env overrides).
- Runtime switches:
  - `connect_provider` for auth/connect flows.
  - `set_model` for active provider/model changes.
  - `refresh_provider_status` for deterministic client-side provider health/status UI.
- Current examples should use active catalog values (for example `openai: gpt-5.2`, `anthropic: claude-opus-4-6`, `google: gemini-3-flash-preview`) instead of legacy placeholders.

### 2.4 Public Protocol Capabilities (Canonical Contract)

`docs/websocket-protocol.md` is the public API contract and UI integration source of truth. `src/server/protocol.ts` is the typed implementation contract.

Protocol references in this PRD must use the exact message names and payload shapes from those files, including:

- Handshake and session metadata: `server_hello` (`sessionId`, `protocolVersion`, `config`), `session_settings`.
- Human loop controls: `ask`/`ask_response`, `approval`/`approval_response`.
- Errors: `error` with required `message` and additive optional `code`/`source`.
- Keepalive: `ping`/`pong`.

---

## 3. Tool Specifications

Tools are implemented in `src/tools/*` and assembled by `src/tools/index.ts`. Execution policy lives in server/session orchestration, not in UI.

### 3.1 Current Built-In Tool Surface

| Tool | Purpose | Safety/Policy Notes |
|---|---|---|
| `bash` | Shell execution | Classified by `src/utils/approval.ts`; emits `approval` when not auto-approved. |
| `read` | Read files with bounds | Path permission checks enforced by permission utilities. |
| `write` | Create/overwrite files | Guarded by permission checks and workspace policy. |
| `edit` | In-place text edits | Guarded write path + deterministic replacement behavior. |
| `notebookEdit` | Notebook cell/file edits | Follows write/edit permission boundaries. |
| `glob` / `grep` | Workspace discovery/search | Read-oriented; permission bounded. |
| `webSearch` / `webFetch` | External search/fetch | Subject to safety and fetch restrictions. |
| `ask` | Pause for user input | Mapped to websocket `ask` event + `ask_response`. |
| `todoWrite` | Progress/task state | Emitted as `todos` server events for clients. |
| `spawnAgent` | Sub-agent delegation | Uses constrained sub-agent prompts and tool scope. |
| `skill` / `memory` | Knowledge/skill reads | Resolved from layered directories; permission bounded. |

### 3.2 Protocol Mapping Requirements

Any tool behavior surfaced to clients must map to documented websocket message contracts:

- Approval path: `approval` event + `approval_response` requestId pairing.
- User clarification path: `ask` event + `ask_response` pairing.
- Failures: `error` event; include machine-readable `code` when available.
- Progress updates: `todos`, `log`, `reasoning`, `assistant_message`.

### 3.3 Legacy Sections in This Document

Detailed code snippets in later legacy sections are historical examples unless they match current `src/*` behavior. When in conflict, repository code and `docs/websocket-protocol.md` take precedence.

## 4. System Prompt

The full system prompt is in the companion file: **`cowork-agent-system-prompt.md`**

Store it as `prompts/system.md` in your project and load it at runtime with template variable injection. Variables shown as `{{variable}}` in the prompt are replaced at startup with actual values from your config.

### Template Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{workingDirectory}}` | Agent's temporary workspace | `/tmp/agent-workspace` |
| `{{outputDirectory}}` | Persistent folder visible to user | `/Users/max/Documents/Agent` |
| `{{uploadsDirectory}}` | Where user-uploaded files land | `/tmp/agent-uploads` |
| `{{currentDate}}` | Today's date | `Saturday, February 7, 2026` |
| `{{currentYear}}` | Current year for search queries | `2026` |
| `{{modelName}}` | Active model identifier | `claude-opus-4-6-20250116` |
| `{{userName}}` | User's name (if provided) | `Max` |
| `{{knowledgeCutoff}}` | Model's training data cutoff | `End of May 2025` |
| `{{skillsDirectory}}` | Path to SKILL.md files (if using skills) | `./skills` |

### Prompt Loader

```typescript
// src/prompt.ts
import fs from "fs/promises";
import path from "path";
import { config } from "./config";

export async function loadSystemPrompt(): Promise<string> {
  let prompt = await fs.readFile("./prompts/system.md", "utf-8");

  // 1. Inject template variables
  const vars: Record<string, string> = {
    workingDirectory: config.workingDirectory,
    outputDirectory: config.outputDirectory,
    uploadsDirectory: config.uploadsDirectory,
    currentDate: new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    }),
    currentYear: new Date().getFullYear().toString(),
    modelName: config.model,
    userName: config.userName || "",
    knowledgeCutoff: config.knowledgeCutoff || "unknown",
    skillsDirectory: config.skillsDirectory || "./skills",
  };

  for (const [key, value] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${key}}}`, value);
  }

  // 2. Append available skills list (see Section 11)
  const { discoverSkills } = await import("./skills");
  const skills = await discoverSkills();
  if (skills.length > 0) {
    const skillList = skills
      .map(s => `- **${s.name}**: ${s.description} (triggers: ${s.triggers.join(", ")})`)
      .join("\n");
    prompt += `\n\n## Available Skills\n\nLoad these with the skill tool before creating the relevant output:\n\n${skillList}`;
  }

  // 3. Append hot-cache memory if it exists
  const hotCachePath = path.join(config.outputDirectory, "AGENT.md");
  try {
    const hotCache = await fs.readFile(hotCachePath, "utf-8");
    prompt += `\n\n## Memory (loaded from previous sessions)\n\n${hotCache}`;
  } catch { /* No previous memory — first session */ }

  return prompt;
}
```

### What the Prompt Covers (~600 lines)

The system prompt is comprehensive and covers these areas at depth:

1. **Core Behavior** — Identity, tone/formatting (CommonMark rules, when to use lists), asking questions (use the ask tool, not typed questions), legal/financial advice caveats, mistake handling, evenhandedness
2. **Tools (14 tools)** — Detailed rules for every built-in tool: bash with 12 git-specific rules, read, write, edit, glob, grep, webSearch, webFetch, ask, todoWrite with task tracking guidance, spawnAgent with sub-agent types, notebookEdit for Jupyter, skill for loading domain knowledge, memory for cross-session persistence, MCP tools
3. **Plan Mode** — When to plan (3+ files, architectural decisions, unclear requirements), when not to plan, 5-step planning workflow
4. **Skills and Templates** — Loading SKILL.md files before creating documents, multiple skill loading, caching
5. **Detailed Guidelines** — Best practices for file operations, bash, web research, communication, proactive capability suggestion, avoiding unnecessary tool use, citation requirements, sub-agent usage
6. **User Wellbeing** — Mental health awareness (mania, psychosis, crisis detection), self-harm prevention, frustration handling
7. **Safety** — Injection defense (4-step protocol), web content restrictions (don't bypass with curl/python), prohibited actions (6 items), actions requiring permission (8 items), sensitive information handling, content safety (weapons, malware, child safety), copyright
8. **Knowledge Cutoff** — When to search, how to present findings
9. **Working with the User's Computer** — File locations, user uploads (when to re-read vs use context), creating outputs, sharing files, artifacts and renderable file types
10. **MCP Integration** — Namespaced tools, injection defense for MCP results, dynamic discovery guidance
11. **Conversation Management** — Multi-step task planning, context management, error handling (try 2-3 approaches)
12. **Decision Examples** — 8 common request patterns with correct action decisions

---

## 5. MCP Server Configuration

MCP servers are defined in `config/mcp-servers.json`. Each server provides tools that are automatically discovered and made available to the agent alongside built-in tools.

### Example config/mcp-servers.json

```json
{
  "servers": [
    {
      "name": "apple-notes",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@anthropic/mcp-apple-notes"]
      }
    },
    {
      "name": "filesystem",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/max/Documents"]
      }
    },
    {
      "name": "remote-service",
      "transport": {
        "type": "http",
        "url": "https://your-mcp-server.com/mcp"
      }
    }
  ]
}
```

At startup, the agent reads this config, creates MCP clients for each server, discovers their tools, and merges them into the tool set passed to `generateText`. No code changes needed — just add a server to the JSON.

---

## 6. Sub-Agent Prompts

Sub-agents are lightweight agents spawned by the main agent for specific tasks. Each has a focused system prompt and a subset of tools.

### 6.1 Explore Agent

**Model:** Use a fast/cheap model (Haiku, GPT-4o-mini, Gemini Flash).
**Tools:** `read`, `glob`, `grep`, `bash` (read-only commands only).

```
You are a fast codebase explorer. Your job is to quickly find files, search for
patterns, and answer structural questions about the codebase. Be concise. Return
file paths, relevant code snippets, and brief summaries. Do not modify any files.
```

### 6.2 Research Agent

**Model:** Use the main model for quality.
**Tools:** `webSearch`, `webFetch`, `read`.

```
You are a research agent. Search the web, read documentation, and synthesize
information. Return a clear, sourced summary. Always include URLs for your
sources. Do not modify any files or run commands.
```

### 6.3 General Agent

**Model:** Inherits from parent.
**Tools:** All tools except `spawnAgent` (no recursive spawning).

```
You are a sub-agent handling a specific task delegated by the main agent.
Complete the task and return your results. Be thorough but concise.
```

---

## 7. Implementation Plan

### Phase 1: Scaffold (Day 1)

- Initialize project: `package.json`, `tsconfig.json`, install `ai`, `zod`, `@ai-sdk/anthropic`
- Create project structure (`src/tools/`, `src/mcp/`, `prompts/`, `config/`)
- Write `config.ts` with provider abstraction
- Write `prompt.ts` loading `system.md` with template variable injection
- Write a minimal `agent.ts` with `generateText` + `maxSteps` + empty tool set
- Write `index.ts` as a CLI entry point (readline interface for chat)
- **Verify:** can send a message and get a response with no tools

### Phase 2: Core Tools (Days 2–3)

- Implement `bash.ts` with `needsApproval` and the CLI approval handler
- Implement `read.ts`, `write.ts`, `edit.ts`
- Implement `glob.ts` (install `fast-glob`)
- Implement `grep.ts` (requires `ripgrep` installed on system)
- Wire all tools into `tools/index.ts` barrel export
- **Verify:** agent can read files, edit them, run commands, find code

### Phase 3: Web Tools (Day 4)

- Implement `webSearch.ts` (get a Brave Search or Exa API key)
- Implement `webFetch.ts` (install `@mozilla/readability`, `jsdom`, `turndown`)
- **Verify:** agent can search the web and read documentation pages

### Phase 4: Agent Tools (Day 5)

- Implement `ask.ts` (tool with no execute — pauses loop, CLI handler prompts user)
- Implement `spawnAgent.ts` with sub-agent prompts and tool subsets
- Write sub-agent prompts (`explore.md`, `research.md`)
- **Verify:** agent can ask questions and delegate work to sub-agents

### Phase 5: MCP Integration (Day 6)

- Implement `src/mcp/index.ts` with `createMCPClient`
- Create `config/mcp-servers.json`
- Merge MCP tools with built-in tools at startup
- **Verify:** connect a test MCP server and confirm its tools appear to the agent

### Phase 6: Polish (Days 7–10)

- Add streaming support (switch to `streamText` for real-time output)
- Add conversation persistence (save/load chat history to disk)
- Add configurable approval rules (auto-approve safe commands, require approval for destructive ones)
- Add a second provider (`@ai-sdk/openai`) and verify model switching works
- Test end-to-end: file editing, code search, web research, sub-agent delegation, MCP tools

---

## 8. Dependencies

See Section 19 for the full `package.json` and system requirements. Core dependencies: `ai` (Vercel AI SDK), `zod`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/mcp`, `fast-glob`, `@mozilla/readability`, `jsdom`, `turndown`.

---

## 9. Tool Description Philosophy

The tool `description` field is the single most important piece of behavioral guidance the agent receives per-tool. The model reads it on **every step** of the agent loop when deciding which tool to call and how to call it. A one-line description produces one-line-quality behavior.

### The Pattern

Every tool description should contain:

1. **What it does** (1 sentence)
2. **When to use it** (positive guidance — use this tool for X, Y, Z)
3. **When NOT to use it** (negative guidance — use the other tool instead)
4. **Constraints and rules** (limits, required flags, formatting requirements)
5. **Error handling hints** (what to do when it fails)

### Example: Thin vs Rich Description

**Thin (what the PRD section 3 shows as a starting point):**
```
"Execute a shell command. Use for git, npm, system operations."
```

**Rich (what the description should actually contain in production):**
```typescript
description: `Execute a bash command with optional timeout. Use for git, npm, docker, system operations, and anything requiring the shell.

IMPORTANT: Do NOT use bash for file operations — use the dedicated tools instead:
- Reading files: use the read tool (not cat/head/tail)
- Writing files: use the write tool (not echo >/tee)
- Editing files: use the edit tool (not sed/awk)
- Finding files: use the glob tool (not find/ls)
- Searching content: use the grep tool (not grep/rg)

Rules:
- Always quote file paths containing spaces with double quotes
- Use absolute paths. Avoid cd.
- Output is truncated after 30,000 characters
- Default timeout: 120s. Max: 600s.
- For pip: always use --break-system-packages flag

Git rules:
- Never force push, amend, or run destructive commands without explicit user permission
- Never use interactive flags (-i) — no TTY available
- Only commit when the user explicitly asks
- Prefer staging specific files over git add -A`,
```

The rich description alone teaches the model 80% of what it needs to know about bash usage. The system prompt reinforces and extends this, but the description is the primary source of truth the model sees in-context at decision time.

### Recommendation

When implementing each tool from Section 3, take the behavioral guidance from the system prompt's tool section and **embed the most critical rules directly in the tool description**. The system prompt provides comprehensive context, but the tool description is what the model has front-of-mind at each step.

---

## 10. Additional Tools

### 10.1 notebookEdit

Edit Jupyter notebook (.ipynb) cells — replace, insert, or delete. Useful for data science workflows.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `notebookPath` | string | Yes | Absolute path to the .ipynb file |
| `cellIndex` | number | Yes | 0-indexed cell number |
| `newSource` | string | Yes | New content for the cell |
| `cellType` | string | No | `"code"` or `"markdown"` (default: current type) |
| `editMode` | string | No | `"replace"` (default), `"insert"`, or `"delete"` |

```typescript
// src/tools/notebookEdit.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";

export const notebookEdit = tool({
  description: `Edit a Jupyter notebook cell. Supports replace, insert, and delete operations.
Use this for any .ipynb file modification. The notebook_path must be absolute.
Cell numbers are 0-indexed. Use editMode=insert to add a new cell at the given index.
Use editMode=delete to remove a cell.`,
  inputSchema: z.object({
    notebookPath: z.string().describe("Absolute path to the .ipynb file"),
    cellIndex: z.number().describe("0-indexed cell number"),
    newSource: z.string().describe("New content for the cell"),
    cellType: z.enum(["code", "markdown"]).optional(),
    editMode: z.enum(["replace", "insert", "delete"]).optional().default("replace"),
  }),
  execute: async ({ notebookPath, cellIndex, newSource, cellType, editMode }) => {
    const raw = await fs.readFile(notebookPath, "utf-8");
    const nb = JSON.parse(raw);
    const cells = nb.cells;

    if (editMode === "delete") {
      cells.splice(cellIndex, 1);
    } else if (editMode === "insert") {
      cells.splice(cellIndex, 0, {
        cell_type: cellType || "code",
        source: newSource.split("\n").map((l, i, a) => l + (i < a.length - 1 ? "\n" : "")),
        metadata: {},
        ...(cellType === "code" || !cellType ? { outputs: [], execution_count: null } : {}),
      });
    } else {
      if (cellIndex >= cells.length) throw new Error(`Cell ${cellIndex} out of range (${cells.length} cells)`);
      cells[cellIndex].source = newSource.split("\n").map((l, i, a) => l + (i < a.length - 1 ? "\n" : ""));
      if (cellType) cells[cellIndex].cell_type = cellType;
    }

    await fs.writeFile(notebookPath, JSON.stringify(nb, null, 1), "utf-8");
    return `Notebook updated: ${editMode} cell ${cellIndex}`;
  },
});
```

### 10.2 skill

Load and execute a skill — a package of best-practice instructions for a specific task type (e.g., creating spreadsheets, presentations, PDFs). Skills are markdown files that get injected into the agent's context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `skillName` | string | Yes | Name of the skill to load |

```typescript
// src/tools/skill.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { config } from "../config";

// Cache loaded skills so they aren't re-read on every call
const loadedSkills = new Map<string, string>();

export const skill = tool({
  description: `Load a skill to get specialized instructions for a task type.
Skills contain best practices for creating high-quality outputs (documents, spreadsheets,
presentations, etc.). Always load the relevant skill BEFORE creating a deliverable.
Available skills are listed in the system prompt. Use the skill name (e.g., "xlsx", "pptx", "pdf", "docx").`,
  inputSchema: z.object({
    skillName: z.string().describe("The skill to load (e.g., 'xlsx', 'pptx', 'pdf')"),
  }),
  execute: async ({ skillName }) => {
    if (loadedSkills.has(skillName)) return loadedSkills.get(skillName)!;

    const skillPath = path.join(config.skillsDirectory, skillName, "SKILL.md");
    try {
      const content = await fs.readFile(skillPath, "utf-8");
      loadedSkills.set(skillName, content);
      return content;
    } catch {
      // Try flat file layout: skills/skillName.md
      const flatPath = path.join(config.skillsDirectory, `${skillName}.md`);
      try {
        const content = await fs.readFile(flatPath, "utf-8");
        loadedSkills.set(skillName, content);
        return content;
      } catch {
        return `Skill "${skillName}" not found. Available skills can be listed with glob on ${config.skillsDirectory}.`;
      }
    }
  },
});
```

### 10.3 memory

Read or update the agent's persistent memory. Memory survives across sessions and helps the agent understand context, decode shorthand, and remember user preferences.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `"read"`, `"write"`, or `"search"` |
| `key` | string | No | Memory key/path (e.g., `"people/sarah"`, `"glossary"`, `"preferences"`) |
| `content` | string | No | Content to write (required for write action) |
| `query` | string | No | Search query (required for search action) |

```typescript
// src/tools/memory.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { config } from "../config";

const memoryDir = path.join(config.outputDirectory, "memory");
const hotCachePath = path.join(config.outputDirectory, "AGENT.md");

export const memory = tool({
  description: `Read or update persistent memory. Memory survives across sessions.

The memory system has two tiers:
1. AGENT.md (hot cache): Working memory with frequently-needed info — acronyms, contacts,
   active projects, preferences. ~50-80 lines. Check this FIRST.
2. memory/ directory (deep storage): Detailed knowledge organized by category —
   memory/glossary.md, memory/people/{name}.md, memory/projects/{name}.md

Use action="read" to retrieve memory. Use action="write" to store new information.
Use action="search" to find something across all memory files.

Lookup flow: AGENT.md → memory/glossary.md → memory/{category}/ → ask user.`,
  inputSchema: z.object({
    action: z.enum(["read", "write", "search"]).describe("What to do"),
    key: z.string().optional().describe("Memory path, e.g. 'people/sarah', 'glossary', 'preferences'"),
    content: z.string().optional().describe("Content to write (for write action)"),
    query: z.string().optional().describe("Search query (for search action)"),
  }),
  execute: async ({ action, key, content, query }) => {
    await fs.mkdir(memoryDir, { recursive: true });

    if (action === "read") {
      if (!key || key === "hot" || key === "AGENT.md") {
        try { return await fs.readFile(hotCachePath, "utf-8"); }
        catch { return "No hot cache found. Start by writing to AGENT.md."; }
      }
      const filePath = path.join(memoryDir, key.endsWith(".md") ? key : `${key}.md`);
      try { return await fs.readFile(filePath, "utf-8"); }
      catch { return `Memory key "${key}" not found.`; }
    }

    if (action === "write") {
      if (!content) throw new Error("content is required for write action");
      if (!key || key === "hot" || key === "AGENT.md") {
        await fs.writeFile(hotCachePath, content, "utf-8");
        return "Hot cache updated.";
      }
      const filePath = path.join(memoryDir, key.endsWith(".md") ? key : `${key}.md`);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      return `Memory written: ${key}`;
    }

    if (action === "search") {
      if (!query) throw new Error("query is required for search action");
      const results: string[] = [];
      // Search hot cache
      try {
        const hot = await fs.readFile(hotCachePath, "utf-8");
        if (hot.toLowerCase().includes(query.toLowerCase())) {
          results.push(`[AGENT.md] ${hot.split("\n").filter(l => l.toLowerCase().includes(query.toLowerCase())).join("\n")}`);
        }
      } catch {}
      // Search memory directory recursively
      const { execSync } = require("child_process");
      try {
        const rg = execSync(`rg -il '${query}' '${memoryDir}'`, { timeout: 5000 }).toString().trim();
        if (rg) results.push(`Files matching "${query}":\n${rg}`);
      } catch {}
      return results.length ? results.join("\n\n") : `No memory found for "${query}".`;
    }

    return "Unknown action.";
  },
});
```

### 10.4 Updated Barrel Export

```typescript
// src/tools/index.ts
import { bash } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { edit } from "./edit";
import { glob } from "./glob";
import { grep } from "./grep";
import { webSearch } from "./webSearch";
import { webFetch } from "./webFetch";
import { ask } from "./ask";
import { todoWrite } from "./todoWrite";
import { spawnAgent } from "./spawnAgent";
import { notebookEdit } from "./notebookEdit";
import { skill } from "./skill";
import { memory } from "./memory";

export const tools = {
  bash, read, write, edit, glob, grep,
  webSearch, webFetch,
  ask, todoWrite,
  spawnAgent, notebookEdit, skill, memory,
};
```

---

## 11. Skills System

> **Note:** Section 16.4 has the updated skill discovery code with layered directory resolution. This section covers the conceptual design.

Skills are packages of domain-specific instructions that teach the agent how to produce high-quality outputs of a specific type. They are loaded on-demand at the start of a task.

### 11.1 Skill Structure

```
skills/
├── xlsx/
│   └── SKILL.md          # Instructions for creating spreadsheets
├── pptx/
│   └── SKILL.md          # Instructions for creating presentations
├── pdf/
│   └── SKILL.md          # Instructions for creating PDFs
├── docx/
│   └── SKILL.md          # Instructions for creating Word docs
├── frontend-design/
│   └── SKILL.md          # Instructions for building web UI
└── custom/
    └── SKILL.md          # User-added skills
```

Each `SKILL.md` contains:
- **Trigger conditions**: When this skill should be loaded (file types, keywords).
- **Best practices**: Step-by-step guidance for creating high-quality output.
- **Code patterns**: Library-specific code to use (e.g., python-pptx, openpyxl, docx-js).
- **Common pitfalls**: What NOT to do.

### 11.2 Skill Discovery

At startup, scan the skills directory and build a registry:

```typescript
// src/skills/index.ts
import fs from "fs/promises";
import path from "path";
import { config } from "../config";

interface SkillEntry {
  name: string;
  path: string;
  triggers: string[];  // Keywords that activate this skill
  description: string; // First line of SKILL.md or a summary
}

export async function discoverSkills(): Promise<SkillEntry[]> {
  const skillsDir = config.skillsDirectory;
  const entries: SkillEntry[] = [];

  try {
    const dirs = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillPath = path.join(skillsDir, dir.name, "SKILL.md");
      try {
        const content = await fs.readFile(skillPath, "utf-8");
        const firstLine = content.split("\n")[0].replace(/^#+\s*/, "");
        entries.push({
          name: dir.name,
          path: skillPath,
          triggers: extractTriggers(dir.name, content),
          description: firstLine,
        });
      } catch { /* skip dirs without SKILL.md */ }
    }
  } catch { /* skills dir doesn't exist */ }

  return entries;
}

function extractTriggers(name: string, content: string): string[] {
  // Extract trigger keywords from skill content or use defaults based on name
  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf:  ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
  };
  return defaults[name] || [name];
}
```

### 11.3 Injecting Skills Into the System Prompt

Skills discovered at startup are listed in the system prompt so the model knows what's available:

```typescript
// In prompt.ts — after template variable injection
export async function loadSystemPrompt(): Promise<string> {
  let prompt = await fs.readFile("./prompts/system.md", "utf-8");
  // ... template variable injection (shown in section 4) ...

  // Append available skills list
  const skills = await discoverSkills();
  if (skills.length > 0) {
    const skillList = skills
      .map(s => `- **${s.name}**: ${s.description} (triggers: ${s.triggers.join(", ")})`)
      .join("\n");
    prompt += `\n\n## Available Skills\n\nLoad these with the skill tool before creating the relevant output type:\n\n${skillList}`;
  }

  return prompt;
}
```

The agent sees the skill list and knows to call the `skill` tool before starting document creation.

---

## 12. Memory & Persistence

The agent needs to remember things across sessions — user preferences, project context, internal terminology, contacts. Without memory, every session starts from scratch.

### 12.1 Two-Tier Architecture

**Tier 1 — Hot Cache (`AGENT.md`)**:
- Lives in the output directory (persists across sessions).
- ~50-80 lines of the most frequently-needed context.
- Loaded automatically at session start (injected into system prompt or first message).
- Contains: top contacts (name + role + nickname), common acronyms, active projects, user preferences.

**Tier 2 — Deep Storage (`memory/` directory)**:
- Lives in the output directory.
- Organized by category: `memory/glossary.md`, `memory/people/`, `memory/projects/`, `memory/context/`.
- Accessed on-demand via the memory tool.
- Contains everything that doesn't fit in the hot cache.

### 12.2 Session Startup

```typescript
// In agent.ts — at session start
import fs from "fs/promises";
import path from "path";
import { config } from "./config";

async function loadHotCache(): Promise<string> {
  const cachePath = path.join(config.outputDirectory, "AGENT.md");
  try {
    const content = await fs.readFile(cachePath, "utf-8");
    return `\n\n# Memory (loaded from previous sessions)\n\n${content}`;
  } catch {
    return ""; // No previous memory
  }
}

// Append to system prompt at runtime
const systemPromptWithMemory = systemPrompt + await loadHotCache();
```

### 12.3 Lookup Flow

When the agent encounters unfamiliar shorthand, names, or acronyms:

1. Check AGENT.md (already in context from session startup)
2. Call `memory` tool with `action: "search"` to check the deep store
3. If not found, ask the user and then save for future sessions

This enables the agent to decode things like "check with JT about the Q3 P&L variance" when it knows JT = John Taylor (Finance Director) from memory.

---

## 13. MCP — Enhanced Integration

The basic MCP integration from Section 3.12 handles the happy path. Production use needs more.

### 13.1 Error Handling & Reconnection

```typescript
// src/mcp/index.ts (enhanced)
import { createMCPClient } from "@ai-sdk/mcp";

interface MCPServerConfig {
  name: string;
  transport: { type: "stdio"; command: string; args: string[] }
    | { type: "http"; url: string };
  required?: boolean;  // If true, agent fails to start without this server
  retries?: number;    // Reconnection attempts (default: 3)
}

export async function loadMCPTools(servers: MCPServerConfig[]) {
  const allTools: Record<string, any> = {};
  const errors: string[] = [];

  for (const server of servers) {
    for (let attempt = 0; attempt <= (server.retries ?? 3); attempt++) {
      try {
        const client = await createMCPClient({
          name: server.name,
          transport: server.transport,
        });
        const tools = await client.tools();

        // Namespace tools to prevent collisions: mcp__serverName__toolName
        for (const [name, tool] of Object.entries(tools)) {
          allTools[`mcp__${server.name}__${name}`] = tool;
        }

        console.log(`[MCP] Connected to ${server.name}: ${Object.keys(tools).length} tools`);
        break; // Success, stop retrying
      } catch (err) {
        if (attempt === (server.retries ?? 3)) {
          const msg = `[MCP] Failed to connect to ${server.name} after ${attempt + 1} attempts: ${err}`;
          if (server.required) throw new Error(msg);
          errors.push(msg);
          console.warn(msg);
        } else {
          console.warn(`[MCP] Retrying ${server.name} (attempt ${attempt + 2})...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Exponential backoff
        }
      }
    }
  }

  return { tools: allTools, errors };
}
```

### 13.2 Tool Namespacing

MCP tool names are prefixed with `mcp__{serverName}__` to prevent collisions with built-in tools. For example, an MCP server named "slack" providing a tool called "search" becomes `mcp__slack__search`. The model sees the full namespaced name in the tool list.

### 13.3 Dynamic Discovery

If the agent needs tools it doesn't have, it can:

1. Check the MCP config for disabled/available servers.
2. Suggest the user connect a relevant service.
3. In the system prompt, this is handled by the "Proactive Capability Suggestion" section.

### 13.4 MCP Server Lifecycle

```typescript
// Track active clients for cleanup
const activeClients: Map<string, any> = new Map();

// Graceful shutdown
process.on("SIGINT", async () => {
  for (const [name, client] of activeClients) {
    try { await client.close(); } catch {}
    console.log(`[MCP] Disconnected from ${name}`);
  }
  process.exit(0);
});
```

---

## 14. Approval Flow

Approval behavior is implemented in production via command classification + websocket approval events, not via standalone CLI prompt snippets.

### 14.1 Current Behavior

- Command classification is handled in `src/utils/approval.ts`.
- `AUTO_APPROVE_PATTERNS` allow deterministic low-risk commands.
- `ALWAYS_WARN_PATTERNS` force explicit approval for high-risk commands.
- Shell control operators (pipes, chaining, redirection, subshells) disable auto-approval.
- `AgentSession.approveCommand()` emits `approval` events with `requestId`, `command`, and `dangerous`, then blocks until `approval_response`.
- `--yolo` bypasses approval in local/explicit bypass mode only.

### 14.2 Protocol Contract

Approval events and replies are part of the public websocket API:

```json
// server -> client
{
  "type": "approval",
  "sessionId": "...",
  "requestId": "req-approval-001",
  "command": "rm -rf /tmp/old-builds",
  "dangerous": true
}

// client -> server
{
  "type": "approval_response",
  "sessionId": "...",
  "requestId": "req-approval-001",
  "approved": false
}
```

### 14.3 Historical Assumptions

The older `onToolCall` examples using inline CLI `readline` approval remain historical reference only. The actual host integration point is websocket `approval`/`approval_response`.

### 14.4 Planned Hardening

- Expand machine-readable error/approval reason codes across all risky action categories.
- Ensure every risky action path emits deterministic approval intent without silent fallback.
- Keep policy logic centralized and test-covered.

---

## 15. Plan Mode

Plan mode exists as an interaction pattern, but not as a protocol-level session mode enum in the current server API.

### 15.1 Current State

- Planning behavior is driven by prompts/instructions and tool usage (`ask`, `todoWrite`, exploratory reads/search) during a turn.
- No dedicated websocket message like `set_plan_mode` currently exists.
- Client applications should treat planning as content-level behavior, not a separate transport state.

### 15.2 Historical vs Current

Historical pseudo-code that modeled plan mode as explicit internal state (`normal | planning`) is not the source of truth today. Current behavior is implemented through normal turns and existing tool contracts.

### 15.3 Planned Direction

If explicit plan-mode controls are added later, they must:

1. Be additive to `ClientMessage` / `ServerEvent`.
2. Be documented in `docs/websocket-protocol.md`.
3. Include validation coverage in `test/protocol.test.ts` and integration coverage in `test/server.test.ts`.

---

## 16. Directory Conventions & Resolution

### 16.1 Active Directory Layers

Configuration and resources resolve across three tiers:

1. Project: `<cwd>/.agent/*`
2. User: `~/.agent/*`
3. Built-in: repository defaults (for example `config/defaults.json`)

### 16.2 Operational State Directories

Runtime state and connection/auth artifacts use `~/.cowork/*` (via `getAiCoworkerPaths()`), including:

- `~/.cowork/auth/connections.json`
- `~/.cowork/sessions/*`
- `~/.cowork/logs/*`

Backward-compatible reads from legacy `~/.ai-coworker/*` locations are supported where implemented.

### 16.3 Resolution Rules (Current)

- Config merge precedence: built-in < user < project < environment variables.
- Skills are discovered from layered directories and surfaced with source metadata.
- Memory/config resources use ordered resolution arrays from `loadConfig()`.
- Output/uploads default to project-relative paths unless overridden.

### 16.4 Historical Notes

Earlier examples that imply single-location config or only `.agent`-based runtime state are historical. Current implementation splits long-lived runtime state (`~/.cowork`) from layered config/skills (`.agent`).

---

## 17. TodoWrite — Detailed Behavior

`todoWrite` remains the agent progress reporting primitive and is part of the websocket event stream consumed by thin clients.

### 17.1 Data Model

The canonical todo item shape remains:

```typescript
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}
```

### 17.2 Runtime Behavior

- The tool submits full-list state updates (overwrite semantics).
- Session emits `todos` events to clients on each update.
- Clients should render the list as the live progress view and avoid deriving hidden state.

### 17.3 Behavioral Expectations

1. Keep exactly one `in_progress` item during active work.
2. Mark items `completed` immediately when done.
3. Include verification tasks for non-trivial changes.
4. Adjust list dynamically as new constraints or sub-tasks emerge.

### 17.4 Historical Assumptions

Prior examples that tied todo rendering to direct host-side mutable globals are historical simplifications. In the current architecture, websocket `todos` events are the integration contract.

## 18. Updated Project Structure

```
cowork-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                # Entry point
│   ├── agent.ts                # Agent loop + state management
│   ├── config.ts               # Layered config loader (project → user → built-in)
│   ├── prompt.ts               # System prompt loader + skill injection + memory
│   ├── types.ts                # Shared types
│   ├── tools/
│   │   ├── index.ts            # Barrel export (14 tools)
│   │   ├── bash.ts
│   │   ├── read.ts
│   │   ├── write.ts
│   │   ├── edit.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── webSearch.ts
│   │   ├── webFetch.ts
│   │   ├── ask.ts
│   │   ├── todoWrite.ts
│   │   ├── spawnAgent.ts
│   │   ├── notebookEdit.ts
│   │   ├── skill.ts
│   │   └── memory.ts
│   ├── skills/
│   │   └── index.ts            # Layered skill discovery
│   ├── mcp/
│   │   └── index.ts            # MCP client (retries + namespacing)
│   └── utils/
│       ├── approval.ts         # Command approval handler
│       └── permissions.ts      # Extended permission logic
├── skills/                     # Built-in skills (shipped with agent)
│   ├── xlsx/SKILL.md
│   ├── pptx/SKILL.md
│   ├── pdf/SKILL.md
│   └── docx/SKILL.md
├── prompts/
│   ├── system.md               # Main system prompt
│   └── sub-agents/
│       ├── explore.md
│       └── research.md
└── config/
    ├── defaults.json           # Built-in default config
    └── mcp-servers.json        # Built-in MCP server definitions

~/.agent/                       # User-level (created on first run)
├── config.json                 # User's global config (API keys, default model)
├── AGENT.md                    # User's global memory hot cache
├── skills/                     # User's custom skills
├── memory/                     # User's global memory
└── mcp-servers.json            # User's global MCP servers

<project>/.agent/               # Project-level (created per project)
├── config.json                 # Project-specific overrides
├── AGENT.md                    # Project-specific hot cache
├── skills/                     # Project-specific skills
├── memory/                     # Project-specific memory
└── mcp-servers.json            # Project-specific MCP servers
```

---

## 19. Updated Dependencies

```json
{
  "name": "cowork-agent",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "ai": "^6.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/openai": "^2.0.0",
    "@ai-sdk/google": "^2.0.0",
    "@ai-sdk/mcp": "^1.0.0",
    "zod": "^3.23.0",
    "fast-glob": "^3.3.0",
    "@mozilla/readability": "^0.5.0",
    "jsdom": "^25.0.0",
    "turndown": "^7.2.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "@types/turndown": "^5.0.0"
  }
}
```

**System requirements:** Node.js 20+, ripgrep (`rg`) for grep tool. Optional: Bun as runtime.

---

## 20. Sources & References

- [Vercel AI SDK — Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [Vercel AI SDK — Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [Vercel AI SDK — Agent Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [Vercel AI SDK — MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK 6 Announcement](https://vercel.com/blog/ai-sdk-6)
- [How to Build AI Agents with Vercel AI SDK](https://vercel.com/kb/guide/how-to-build-ai-agents-with-vercel-and-the-ai-sdk)
- [Vercel AI SDK GitHub](https://github.com/vercel/ai)
- [@ai-sdk/mcp on npm](https://www.npmjs.com/package/@ai-sdk/mcp)
- [mcp-to-ai-sdk CLI](https://vercel.com/blog/generate-static-ai-sdk-tools-from-mcp-servers-with-mcp-to-ai-sdk)
