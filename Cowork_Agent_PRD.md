# Cowork Agent — Product Requirements Document

An open-source, model-agnostic desktop AI agent built from scratch on the Vercel AI SDK.

**Version:** 1.0
**Date:** February 2026

---

## 1. Overview

This document defines the architecture, tools, system prompt, and implementation plan for building an open-source AI agent modeled after Anthropic's Cowork mode. The agent is built from scratch on the Vercel AI SDK, is fully model-agnostic, and designed to run as a local process on the user's machine with access to their filesystem, a shell, web search, and extensible MCP integrations.

The goal is a functional agent core — not a UI. The agent should be usable from a CLI, a script, or as a backend for any frontend you build later.

### 1.1 Design Principles

- **Model-agnostic:** Swap providers by changing one line. The system prompt and tools are provider-independent.
- **Tool-first:** The agent's capabilities come from its tools, not the model. Any model that supports tool calling works.
- **MCP-native:** External integrations plug in via MCP servers, not custom code.
- **Single-file tools:** Each tool is one TypeScript file with a Zod schema and execute function.
- **Minimal dependencies:** Vercel AI SDK + Zod + a few utility packages. No frameworks, no ORMs, no build steps beyond TypeScript.

### 1.2 Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js / Bun | Native FS access, child_process for bash, fast startup |
| Agent Framework | Vercel AI SDK (`ai`) | `generateText` + `maxSteps` or `ToolLoopAgent` for the agent loop |
| Schema Validation | Zod | Type-safe tool parameter definitions, required by AI SDK |
| Model Providers | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, etc. | Swap providers without changing tool code |
| MCP Integration | `@ai-sdk/mcp` | Native MCP client for connecting external tool servers |
| File Utilities | `fast-glob`, Node `fs/path` | Glob pattern matching, file operations |
| Search Backend | Brave Search API or Tavily | Web search tool backend (API key required) |
| HTML Processing | `@mozilla/readability` + `turndown` | WebFetch: HTML → markdown conversion |

---

## 2. Architecture

### 2.1 Project Structure

```
cowork-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point — CLI or programmatic
│   ├── agent.ts              # Main agent definition and loop
│   ├── config.ts             # Provider config, model selection
│   ├── prompt.ts             # System prompt loader with template injection
│   ├── types.ts              # Shared TypeScript types
│   ├── tools/
│   │   ├── index.ts          # Barrel export of all tools
│   │   ├── bash.ts           # Shell command execution
│   │   ├── read.ts           # Read files
│   │   ├── write.ts          # Write/create files
│   │   ├── edit.ts           # String replacement in files
│   │   ├── glob.ts           # File pattern matching
│   │   ├── grep.ts           # Content search (ripgrep)
│   │   ├── webSearch.ts      # Web search via API
│   │   ├── webFetch.ts       # Fetch URL + convert to markdown
│   │   ├── ask.ts            # Pause and ask user for input
│   │   ├── todoWrite.ts      # Progress tracking todo list
│   │   └── spawnAgent.ts     # Launch a sub-agent
│   ├── mcp/
│   │   └── index.ts          # MCP client setup and tool loading
│   └── utils/
│       ├── sandbox.ts        # Optional: file operation sandboxing
│       └── permissions.ts    # Tool approval logic
├── prompts/
│   ├── system.md             # Main system prompt (markdown source)
│   └── sub-agents/
│       ├── explore.md        # Explore sub-agent prompt
│       └── research.md       # Research sub-agent prompt
└── config/
    └── mcp-servers.json      # MCP server definitions
```

### 2.2 Agent Loop

The agent uses the AI SDK's `generateText` with `maxSteps` (v4 pattern) or `ToolLoopAgent` (v6 pattern). Both accomplish the same thing: model receives messages → decides to call a tool → tool executes → result fed back → model decides next action → repeat until done.

#### v4 Pattern (generateText + maxSteps)

```typescript
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { tools } from "./tools";
import { systemPrompt } from "./prompt";

const { text, steps } = await generateText({
  model: anthropic("claude-opus-4-6-20250116"),
  system: systemPrompt,
  tools,
  maxSteps: 100,
  messages: conversationHistory,
  onStepFinish({ text, toolCalls, toolResults }) {
    // Log progress, update UI, etc.
  },
});
```

#### v6 Pattern (ToolLoopAgent)

```typescript
import { ToolLoopAgent, stepCountIs } from "ai";

const agent = new ToolLoopAgent({
  model: anthropic("claude-opus-4-6-20250116"),
  system: systemPrompt,
  tools,
  stopWhen: stepCountIs(100),
});

const result = await agent.run({ messages: conversationHistory });
```

Both patterns are equivalent. Use whichever matches your AI SDK version. The tools and system prompt are identical either way.

### 2.3 Model Configuration

> **Note:** Section 16.3 has the full config with layered directory resolution (project → user → built-in). This section shows the minimal starting point.

The agent is model-agnostic. Provider selection is isolated to a single config file:

```typescript
// src/config.ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import path from "path";

const providers: Record<string, (id: string) => any> = {
  anthropic: (id: string) => anthropic(id),
  openai: (id: string) => openai(id),
  google: (id: string) => google(id),
};

export const config = {
  // --- Model ---
  provider: "anthropic",
  model: "claude-opus-4-6-20250116",
  subAgentModel: "claude-haiku-4-5-20251001",

  // --- Directories (injected into system prompt as {{variables}}) ---
  workingDirectory: process.env.AGENT_WORKING_DIR || process.cwd(),
  outputDirectory: process.env.AGENT_OUTPUT_DIR || path.join(process.cwd(), "output"),
  uploadsDirectory: process.env.AGENT_UPLOADS_DIR || path.join(process.cwd(), "uploads"),
  skillsDirectory: process.env.AGENT_SKILLS_DIR || path.join(process.cwd(), "skills"),

  // --- User ---
  userName: process.env.AGENT_USER_NAME || "",

  // --- Knowledge ---
  knowledgeCutoff: "End of May 2025",  // Update when switching models
};

export function getModel(id?: string) {
  const p = providers[config.provider];
  if (!p) throw new Error(`Unknown provider: ${config.provider}`);
  return p(id || config.model);
}
```

The config sources directory paths from environment variables (`AGENT_WORKING_DIR`, `AGENT_OUTPUT_DIR`, etc.) with sensible defaults. The host application sets these at launch. The prompt loader reads these values and injects them into every `{{variable}}` in the system prompt.

---

## 3. Tool Specifications

Each tool is a single TypeScript file exporting a Vercel AI SDK `tool()` definition. All tools follow the same pattern: a description the model reads, an `inputSchema` defined with Zod, and an `execute` function.

### 3.1 bash

Execute shell commands. This is the most powerful tool — it gives the agent access to the full system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | The shell command to execute |
| `timeout` | number | No | Timeout in ms (default: 120000, max: 600000) |

**Approval:** `needsApproval: true`. Every bash command should be surfaced to the user for approval before execution. Your approval handler can auto-approve safe patterns (`ls`, `cat`, `echo`) and require confirmation for destructive ones (`rm`, `mv`, `chmod`).

```typescript
// src/tools/bash.ts
import { tool } from "ai";
import { z } from "zod";
import { exec } from "child_process";

export const bash = tool({
  description: "Execute a shell command. Use for git, npm, system operations, listing directories, running scripts. Always quote paths with spaces.",
  inputSchema: z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().default(120000).describe("Timeout in ms"),
  }),
  needsApproval: true,
  execute: async ({ command, timeout }) => {
    return new Promise((resolve) => {
      exec(command, { timeout, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
        resolve({
          stdout: stdout.slice(0, 30000),
          stderr: stderr.slice(0, 10000),
          exitCode: err?.code || 0,
        });
      });
    });
  },
});
```

### 3.2 read

Read file contents. Returns text with line numbers. Supports offset/limit for large files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | Yes | Absolute path to the file |
| `offset` | number | No | Line number to start reading from (1-indexed) |
| `limit` | number | No | Max lines to read (default: 2000) |

```typescript
// src/tools/read.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";

export const read = tool({
  description: "Read a file from the filesystem. Returns content with line numbers. Use offset/limit for large files.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute path to the file"),
    offset: z.number().optional().describe("Start line (1-indexed)"),
    limit: z.number().optional().default(2000).describe("Max lines to return"),
  }),
  execute: async ({ filePath, offset, limit }) => {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const start = (offset || 1) - 1;
    const sliced = lines.slice(start, start + limit);
    const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`);
    return numbered.join("\n");
  },
});
```

### 3.3 write

Write content to a file. Creates the file if it doesn't exist, overwrites if it does.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | Yes | Absolute path to the file |
| `content` | string | Yes | Content to write |

```typescript
// src/tools/write.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

export const write = tool({
  description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute file path to write"),
    content: z.string().describe("Content to write"),
  }),
  execute: async ({ filePath, content }) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return `Wrote ${content.length} chars to ${filePath}`;
  },
});
```

### 3.4 edit

Perform exact string replacement in a file. Fails if the old string isn't found or isn't unique (unless `replaceAll` is true).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | Yes | Absolute path to the file |
| `oldString` | string | Yes | Exact text to find and replace |
| `newString` | string | Yes | Text to replace it with |
| `replaceAll` | boolean | No | Replace all occurrences (default: false) |

```typescript
// src/tools/edit.ts
import { tool } from "ai";
import { z } from "zod";
import fs from "fs/promises";

export const edit = tool({
  description: "Replace exact text in a file. The oldString must exist in the file. Use replaceAll to replace every occurrence.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute file path"),
    oldString: z.string().describe("Exact text to replace"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences"),
  }),
  execute: async ({ filePath, oldString, newString, replaceAll }) => {
    let content = await fs.readFile(filePath, "utf-8");
    if (!content.includes(oldString)) throw new Error(`oldString not found in ${filePath}`);
    if (!replaceAll) {
      const count = content.split(oldString).length - 1;
      if (count > 1) throw new Error(`oldString found ${count} times. Provide more context or set replaceAll.`);
    }
    content = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
    await fs.writeFile(filePath, content, "utf-8");
    return "Edit applied.";
  },
});
```

### 3.5 glob

Find files matching a glob pattern. Returns paths sorted by modification time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern (e.g. `**/*.ts`) |
| `cwd` | string | No | Directory to search from (default: workspace root) |

```typescript
// src/tools/glob.ts
import { tool } from "ai";
import { z } from "zod";
import fg from "fast-glob";

export const glob = tool({
  description: "Find files matching a glob pattern. Returns file paths sorted by modification time.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match"),
    cwd: z.string().optional().describe("Directory to search from"),
  }),
  execute: async ({ pattern, cwd }) => {
    const files = await fg(pattern, { cwd: cwd || process.cwd(), stats: true, dot: false });
    files.sort((a, b) => (b.stats?.mtimeMs || 0) - (a.stats?.mtimeMs || 0));
    return files.map(f => f.path).join("\n") || "No files found.";
  },
});
```

### 3.6 grep

Search file contents using regex patterns. Wraps ripgrep for speed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | File or directory to search |
| `fileGlob` | string | No | Filter files (e.g. `*.ts`) |
| `contextLines` | number | No | Lines of context around matches |
| `caseSensitive` | boolean | No | Case sensitive (default: true) |

```typescript
// src/tools/grep.ts
import { tool } from "ai";
import { z } from "zod";
import { execSync } from "child_process";

export const grep = tool({
  description: "Search file contents for a regex pattern. Uses ripgrep. Returns matching lines with filenames and line numbers.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern"),
    path: z.string().optional().describe("File or directory to search"),
    fileGlob: z.string().optional().describe("Glob to filter files"),
    contextLines: z.number().optional().describe("Context lines around matches"),
    caseSensitive: z.boolean().optional().default(true),
  }),
  execute: async ({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive }) => {
    let cmd = "rg --line-number";
    if (!caseSensitive) cmd += " -i";
    if (contextLines) cmd += ` -C ${contextLines}`;
    if (fileGlob) cmd += ` --glob '${fileGlob}'`;
    cmd += ` '${pattern}' ${searchPath || "."}`;
    try {
      return execSync(cmd, { maxBuffer: 1024 * 1024 * 5 }).toString().slice(0, 30000);
    } catch {
      return "No matches found.";
    }
  },
});
```

### 3.7 webSearch

Search the web. Backed by Brave Search API, Tavily, or any search provider you configure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `maxResults` | number | No | Maximum results (default: 10) |

```typescript
// src/tools/webSearch.ts
import { tool } from "ai";
import { z } from "zod";

export const webSearch = tool({
  description: "Search the web for current information. Use for anything beyond the knowledge cutoff or for up-to-date info.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().default(10),
  }),
  execute: async ({ query, maxResults }) => {
    // Swap this implementation for your preferred search API
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      { headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY! } }
    );
    const data = await res.json();
    return (
      data.web?.results
        ?.map((r: any) => `${r.title}\n${r.url}\n${r.description}`)
        .join("\n\n") || "No results"
    );
  },
});
```

### 3.8 webFetch

Fetch a URL and convert the HTML to clean markdown for the model to read.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `maxLength` | number | No | Max characters to return (default: 50000) |

```typescript
// src/tools/webFetch.ts
// Requires: npm install @mozilla/readability jsdom turndown
import { tool } from "ai";
import { z } from "zod";

export const webFetch = tool({
  description: "Fetch a URL and return its content as markdown. Use to read documentation, articles, or any web page.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch"),
    maxLength: z.number().optional().default(50000),
  }),
  execute: async ({ url, maxLength }) => {
    const { Readability } = require("@mozilla/readability");
    const { JSDOM } = require("jsdom");
    const TurndownService = require("turndown");
    const res = await fetch(url);
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const turndown = new TurndownService();
    const md = article
      ? turndown.turndown(article.content)
      : turndown.turndown(html);
    return md.slice(0, maxLength);
  },
});
```

### 3.9 ask

Pause execution and ask the user a question. The agent loop stops, the question is surfaced to the user, and their response is fed back as the tool result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | The question to ask the user |
| `options` | string[] | No | Multiple-choice options (user can always type a custom answer) |

**Implementation note:** This tool has **no execute function**. When the model calls it, the agent loop pauses (`generateText` returns with a tool call but no result). Your host application handles prompting the user and resuming the loop with their answer.

```typescript
// src/tools/ask.ts
import { tool } from "ai";
import { z } from "zod";

export const ask = tool({
  description: "Ask the user a clarifying question. Use when the request is ambiguous or you need a decision. Provide options when possible.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask"),
    options: z.array(z.string()).optional().describe("Multiple-choice options"),
  }),
  // No execute function — this pauses the loop.
  // The host application handles user input and resumes.
});
```

### 3.10 todoWrite

Track progress on multi-step tasks. The host application renders the todo list as a widget. This tool updates the entire list each time it's called (overwrite, not append).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `todos` | array | Yes | Full list of todos with content, status, and activeForm |

Each todo item has:
- `content` (string): Imperative description — "Run tests"
- `status` (string): `"pending"`, `"in_progress"`, or `"completed"`
- `activeForm` (string): Present continuous — "Running tests"

```typescript
// src/tools/todoWrite.ts
import { tool } from "ai";
import { z } from "zod";

const todoSchema = z.object({
  content: z.string().describe("Imperative description (e.g. 'Run tests')"),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().describe("Present continuous form (e.g. 'Running tests')"),
});

// Shared state — the host can read this to render the widget
export let currentTodos: z.infer<typeof todoSchema>[] = [];

export const todoWrite = tool({
  description: "Update the todo list to track progress on multi-step tasks. Overwrites the full list each call.",
  inputSchema: z.object({
    todos: z.array(todoSchema).describe("The complete updated todo list"),
  }),
  execute: async ({ todos }) => {
    currentTodos = todos;
    const summary = todos.map(t => `[${t.status}] ${t.content}`).join("\n");
    return `Todo list updated:\n${summary}`;
  },
});
```

### 3.11 spawnAgent

Launch a sub-agent for a specific task. Sub-agents run with their own system prompt and tool subset, can use a cheaper/faster model, and return their result to the parent agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | Yes | Description of what the sub-agent should do |
| `agentType` | string | No | Agent type: `explore`, `research`, or `general` (default: `general`) |

```typescript
// src/tools/spawnAgent.ts
import { tool, generateText } from "ai";
import { z } from "zod";
import { getModel, config } from "../config";
import { subAgentPrompts, subAgentTools } from "../prompt";

export const spawnAgent = tool({
  description:
    "Launch a sub-agent for a specific task. Use for parallel work, research, or isolating a complex sub-task.",
  inputSchema: z.object({
    task: z.string().describe("What the sub-agent should accomplish"),
    agentType: z
      .enum(["explore", "research", "general"])
      .optional()
      .default("general"),
  }),
  execute: async ({ task, agentType }) => {
    const { text } = await generateText({
      model: getModel(config.subAgentModel),
      system: subAgentPrompts[agentType],
      tools: subAgentTools[agentType],
      maxSteps: 50,
      prompt: task,
    });
    return text;
  },
});
```

### 3.12 MCP Server Integration

External tools connect via MCP servers. The `@ai-sdk/mcp` package handles discovery and execution:

```typescript
// src/mcp/index.ts
import { createMCPClient } from "@ai-sdk/mcp";

export async function loadMCPTools(servers: MCPServerConfig[]) {
  const allTools = {};
  for (const server of servers) {
    const client = await createMCPClient({
      name: server.name,
      transport: server.transport,
      // transport: { type: "stdio", command: "npx", args: [...] }
      // or: { type: "http", url: "https://..." }
    });
    const tools = await client.tools();
    Object.assign(allTools, tools);
  }
  return allTools;
}
```

MCP servers are defined in `config/mcp-servers.json` and loaded at startup. Their tools are merged with the built-in tools and passed to `generateText` together. No code changes needed to add new integrations — just add a server to the JSON.

### 3.13 Tool Barrel Export

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

export const tools = {
  bash,
  read,
  write,
  edit,
  glob,
  grep,
  webSearch,
  webFetch,
  ask,
  todoWrite,
  spawnAgent,
};
```

---

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

- Implement `webSearch.ts` (get a Brave Search or Tavily API key)
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

The `needsApproval` mechanism on the bash tool (and any other destructive tool) requires the host application to implement an approval handler. Without it, the agent loop stalls.

### 14.1 How It Works

When the AI SDK encounters a tool call with `needsApproval: true`, the `generateText` loop pauses. The incomplete step is returned with the tool call but no result. The host must:

1. Present the pending action to the user.
2. Get approval or rejection.
3. If approved, execute the tool and feed the result back.
4. If rejected, feed a rejection message back and the model will adjust.

### 14.2 CLI Implementation

```typescript
// src/utils/approval.ts
import readline from "readline";

const AUTO_APPROVE_PATTERNS = [
  /^ls\b/, /^pwd$/, /^echo\b/, /^cat\b/, /^head\b/, /^tail\b/,
  /^git\s+(status|log|diff|branch)\b/, /^node\s+--version/,
  /^which\b/, /^type\b/, /^man\b/,
];

const ALWAYS_WARN_PATTERNS = [
  /\brm\s+-rf\b/, /\bgit\s+push\s+--force\b/, /\bgit\s+reset\s+--hard\b/,
  /\bchmod\b/, /\bchown\b/, /\bsudo\b/, /\bcurl\b.*\|\s*bash/,
  /\bdrop\s+table\b/i, /\bdelete\s+from\b/i,
];

export async function approveCommand(command: string): Promise<boolean> {
  // Auto-approve safe read-only commands
  if (AUTO_APPROVE_PATTERNS.some(p => p.test(command))) return true;

  // Always warn on dangerous commands
  const dangerous = ALWAYS_WARN_PATTERNS.some(p => p.test(command));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prefix = dangerous ? "⚠️  DANGEROUS: " : "Run: ";

  return new Promise((resolve) => {
    rl.question(`${prefix}${command}\nApprove? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}
```

### 14.3 Wiring Into the Agent Loop

```typescript
// In agent.ts
import { generateText } from "ai";
import { approveCommand } from "./utils/approval";

const result = await generateText({
  model: getModel(),
  system: systemPrompt,
  tools,
  maxSteps: 100,
  messages: conversationHistory,

  // Handle tool approval
  async onToolCall({ toolCall }) {
    if (toolCall.toolName === "bash") {
      const approved = await approveCommand(toolCall.args.command);
      if (!approved) {
        return { error: "User rejected this command." };
      }
    }
    // Return undefined to proceed with normal execution
    return undefined;
  },
});
```

### 14.4 Extending Approval

The approval pattern can be extended beyond bash:

- **File deletion**: Require approval for write/edit operations that reduce file size significantly.
- **Web requests**: Require approval for webFetch to domains the user hasn't pre-approved.
- **Messages**: If MCP tools can send messages (email, Slack, iMessage), require approval for all sends.
- **Purchases**: Any tool that involves financial transactions.

The `needsApproval` flag can be set on any tool, or the `onToolCall` handler can implement custom logic.

---

## 15. Plan Mode

For complex tasks, the agent should plan before implementing. Plan mode lets it explore the codebase, design an approach, and get user approval before writing code.

### 15.1 Workflow

```
User request → Agent enters plan mode → Explores codebase → Writes plan →
User reviews → Approved? → Agent implements
                          → Rejected? → Agent revises plan
```

### 15.2 Implementation

Plan mode is implemented as agent state, not a separate tool. The agent tracks whether it's planning or implementing:

```typescript
// src/agent.ts
interface AgentState {
  mode: "normal" | "planning";
  planFile?: string;
}

// The system prompt tells the agent when to enter plan mode.
// The agent writes its plan to a file and asks for approval via the ask tool.
```

In the system prompt, plan mode guidance tells the agent:

**When to plan** (enter plan mode):
- New feature implementation (multiple valid approaches)
- Multi-file changes (3+ files)
- Architectural decisions
- Unclear requirements (need to explore first)

**When NOT to plan** (just do it):
- Single-line fixes, typos
- Adding a single function with clear requirements
- Pure research tasks

**How to plan**:
1. Use read/glob/grep to explore the relevant code.
2. Write a plan file (markdown) in the working directory.
3. Use the ask tool to present the plan and get approval.
4. On approval, implement. On rejection, revise.

---

## 16. Directory Conventions & Resolution

The agent uses a three-tier directory system similar to git or npm. Settings, skills, memory, and MCP configs resolve in a layered hierarchy: **project → user → built-in**, where project-level always wins.

### 16.1 The Three Tiers

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 1 — Project-level  (.agent/ in working directory)     │
│  Highest priority. Per-project overrides.                   │
│                                                             │
│  .agent/                                                    │
│  ├── config.json         # Project model, provider, MCP     │
│  ├── AGENT.md            # Project-specific hot cache        │
│  ├── skills/             # Project-specific skills           │
│  │   └── my-api/SKILL.md                                    │
│  ├── memory/             # Project-specific memory           │
│  │   ├── glossary.md                                        │
│  │   └── people/                                            │
│  └── mcp-servers.json    # Project MCP servers               │
├─────────────────────────────────────────────────────────────┤
│  Tier 2 — User-level  (~/.agent/)                           │
│  User's global defaults. Shared across all projects.        │
│                                                             │
│  ~/.agent/                                                  │
│  ├── config.json         # Default model, provider, API keys│
│  ├── AGENT.md            # Global hot cache (contacts, prefs)│
│  ├── skills/             # User's custom skills              │
│  │   └── my-style/SKILL.md                                  │
│  ├── memory/             # Global memory                     │
│  │   ├── glossary.md                                        │
│  │   └── people/                                            │
│  └── mcp-servers.json    # Global MCP servers (Slack, etc.)  │
├─────────────────────────────────────────────────────────────┤
│  Tier 3 — Built-in  (shipped with agent)                    │
│  Lowest priority. Defaults and bundled skills.              │
│                                                             │
│  <agent-install>/                                           │
│  ├── skills/             # Bundled skills (xlsx, pptx, etc.)│
│  ├── prompts/system.md   # System prompt                     │
│  └── config/defaults.json                                    │
└─────────────────────────────────────────────────────────────┘
```

### 16.2 Resolution Rules

| Resource | Resolution Order | Merge Behavior |
|----------|-----------------|----------------|
| **config.json** | project → user → built-in | Deep merge. Project overrides user overrides defaults. |
| **AGENT.md** | project → user | Project-level wins entirely. If no project AGENT.md, use user's. |
| **skills/** | All three tiers scanned | Union. All discovered skills are available. Project skills override same-named user/built-in skills. |
| **memory/** | project → user | Project memory searched first. User memory is fallback. |
| **mcp-servers.json** | project → user | Merge. Project servers added alongside user's global servers. Same-named servers: project wins. |

### 16.3 Config Loading

```typescript
// src/config.ts (updated with layered resolution)
import fs from "fs/promises";
import path from "path";
import os from "os";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

const providers: Record<string, (id: string) => any> = {
  anthropic: (id) => anthropic(id),
  openai: (id) => openai(id),
  google: (id) => google(id),
};

// --- Directory paths ---
const projectAgentDir = path.join(process.cwd(), ".agent");
const userAgentDir = path.join(os.homedir(), ".agent");
const builtInDir = path.resolve(__dirname, "..");

interface AgentConfig {
  provider: string;
  model: string;
  subAgentModel: string;
  workingDirectory: string;
  outputDirectory: string;
  uploadsDirectory: string;
  userName: string;
  knowledgeCutoff: string;
  // Resolved directory arrays (all tiers, in priority order)
  skillsDirs: string[];
  memoryDirs: string[];
  configDirs: string[];
}

async function loadJsonSafe(filePath: string): Promise<Record<string, any>> {
  try { return JSON.parse(await fs.readFile(filePath, "utf-8")); }
  catch { return {}; }
}

export async function loadConfig(): Promise<AgentConfig> {
  // Load and merge configs: built-in < user < project < env vars
  const builtIn = await loadJsonSafe(path.join(builtInDir, "config", "defaults.json"));
  const user = await loadJsonSafe(path.join(userAgentDir, "config.json"));
  const project = await loadJsonSafe(path.join(projectAgentDir, "config.json"));
  const merged = { ...builtIn, ...user, ...project };

  return {
    provider: process.env.AGENT_PROVIDER || merged.provider || "anthropic",
    model: process.env.AGENT_MODEL || merged.model || "claude-sonnet-4-5-20250929",
    subAgentModel: merged.subAgentModel || "claude-haiku-4-5-20251001",
    workingDirectory: process.env.AGENT_WORKING_DIR || process.cwd(),
    outputDirectory: process.env.AGENT_OUTPUT_DIR || merged.outputDirectory || path.join(process.cwd(), "output"),
    uploadsDirectory: process.env.AGENT_UPLOADS_DIR || path.join(process.cwd(), "uploads"),
    userName: process.env.AGENT_USER_NAME || merged.userName || "",
    knowledgeCutoff: merged.knowledgeCutoff || "End of May 2025",

    // Skill dirs: project → user → built-in (all scanned, union)
    skillsDirs: [
      path.join(projectAgentDir, "skills"),
      path.join(userAgentDir, "skills"),
      path.join(builtInDir, "skills"),
    ],
    // Memory dirs: project → user (searched in order)
    memoryDirs: [
      path.join(projectAgentDir, "memory"),
      path.join(userAgentDir, "memory"),
    ],
    // Config dirs for MCP, sub-agent prompts, etc.
    configDirs: [
      projectAgentDir,
      userAgentDir,
      path.join(builtInDir, "config"),
    ],
  };
}

export function getModel(config: AgentConfig, id?: string) {
  const p = providers[config.provider];
  if (!p) throw new Error(`Unknown provider: ${config.provider}`);
  return p(id || config.model);
}
```

### 16.4 Skill Discovery (Updated for Layered Resolution)

```typescript
// src/skills/index.ts (updated)
import fs from "fs/promises";
import path from "path";

interface SkillEntry {
  name: string;
  path: string;
  source: "project" | "user" | "built-in";
  triggers: string[];
  description: string;
}

export async function discoverSkills(skillsDirs: string[]): Promise<SkillEntry[]> {
  const seen = new Set<string>();  // Track names to enforce priority
  const entries: SkillEntry[] = [];
  const sources: Array<"project" | "user" | "built-in"> = ["project", "user", "built-in"];

  for (let i = 0; i < skillsDirs.length; i++) {
    const dir = skillsDirs[i];
    const source = sources[i] || "built-in";

    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() || seen.has(item.name)) continue;

        const skillPath = path.join(dir, item.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillPath, "utf-8");
          const firstLine = content.split("\n")[0].replace(/^#+\s*/, "");
          seen.add(item.name);
          entries.push({
            name: item.name,
            path: skillPath,
            source,
            triggers: extractTriggers(item.name, content),
            description: firstLine,
          });
        } catch { /* no SKILL.md in this dir */ }
      }
    } catch { /* dir doesn't exist */ }
  }

  return entries;
}

function extractTriggers(name: string, content: string): string[] {
  // Check for a TRIGGERS: line in the skill, fall back to defaults
  const triggerMatch = content.match(/^TRIGGERS?:\s*(.+)$/im);
  if (triggerMatch) return triggerMatch[1].split(",").map(t => t.trim());

  const defaults: Record<string, string[]> = {
    xlsx: ["spreadsheet", "excel", ".xlsx", "csv", "data table", "chart"],
    pptx: ["presentation", "slides", "powerpoint", ".pptx", "deck", "pitch"],
    pdf:  ["pdf", ".pdf", "form", "merge", "split"],
    docx: ["document", "word", ".docx", "report", "letter", "memo"],
  };
  return defaults[name] || [name];
}
```

### 16.5 Memory Resolution (Updated)

```typescript
// In memory tool — search across tiers
async function findMemory(key: string, memoryDirs: string[]): Promise<string | null> {
  for (const dir of memoryDirs) {
    const filePath = path.join(dir, key.endsWith(".md") ? key : `${key}.md`);
    try { return await fs.readFile(filePath, "utf-8"); }
    catch { continue; }
  }
  return null;
}

// Hot cache: check project .agent/AGENT.md, then user ~/.agent/AGENT.md
async function loadHotCache(configDirs: string[]): Promise<string> {
  for (const dir of configDirs) {
    try { return await fs.readFile(path.join(dir, "AGENT.md"), "utf-8"); }
    catch { continue; }
  }
  return "";
}
```

### 16.6 MCP Config Resolution

```typescript
// Load MCP servers from project → user → built-in, merging by name
async function loadMCPConfig(configDirs: string[]): Promise<MCPServerConfig[]> {
  const serversByName = new Map<string, MCPServerConfig>();

  // Load in reverse priority so higher-priority overwrites
  for (const dir of [...configDirs].reverse()) {
    try {
      const raw = await fs.readFile(path.join(dir, "mcp-servers.json"), "utf-8");
      const { servers } = JSON.parse(raw);
      for (const server of servers) {
        serversByName.set(server.name, server);
      }
    } catch { continue; }
  }

  return Array.from(serversByName.values());
}
```

---

## 17. TodoWrite — Detailed Behavior

The todoWrite tool is the agent's progress tracker. It renders as a live widget in the host UI, giving the user real-time visibility into what the agent is doing on multi-step tasks.

### 17.1 Data Model

Each call to todoWrite replaces the entire list (overwrite, not append). This keeps the model's representation simple — it always sends the complete current state.

```typescript
interface TodoItem {
  content: string;      // Imperative: "Run the test suite"
  status: "pending" | "in_progress" | "completed";
  activeForm: string;   // Present continuous: "Running the test suite"
}
```

The **two forms** serve different purposes:
- `content` is shown in the list at rest (like a checklist)
- `activeForm` is shown in a status line while the task is in_progress (e.g., "Running the test suite..." as a live indicator)

### 17.2 UX Flow

Here's how the agent uses todoWrite during a typical multi-step task:

```
User: "Add dark mode to the app and make sure tests pass"

Agent thinks: This is multi-step. Create a todo list.

→ todoWrite([
    { content: "Analyze current theme system",      status: "in_progress", activeForm: "Analyzing current theme system" },
    { content: "Implement dark mode toggle",         status: "pending",     activeForm: "Implementing dark mode toggle" },
    { content: "Update components for theme support", status: "pending",     activeForm: "Updating components" },
    { content: "Run tests and fix failures",         status: "pending",     activeForm: "Running tests" },
    { content: "Verify implementation",              status: "pending",     activeForm: "Verifying implementation" },
  ])

Agent reads files, explores codebase...

→ todoWrite([
    { content: "Analyze current theme system",      status: "completed",   activeForm: "Analyzing current theme system" },
    { content: "Implement dark mode toggle",         status: "in_progress", activeForm: "Implementing dark mode toggle" },
    { content: "Update components for theme support", status: "pending",     activeForm: "Updating components" },
    { content: "Run tests and fix failures",         status: "pending",     activeForm: "Running tests" },
    { content: "Verify implementation",              status: "pending",     activeForm: "Verifying implementation" },
  ])

Agent writes code...
...and so on, progressing through each item.
```

### 17.3 Behavioral Rules

These rules should be embedded in both the tool description AND the system prompt:

1. **Default to using it.** Any task involving tool calls should get a todo list, unless it's trivially simple (< 3 steps, purely conversational). Err on the side of creating one — users like seeing progress.

2. **One in_progress at a time.** Exactly one task should be `in_progress`. Not zero (looks stalled), not two (confusing). Complete the current task before starting the next.

3. **Immediate transitions.** Mark a task `completed` the moment you finish it, in the same turn. Don't batch completions at the end. The user is watching the widget update in real time.

4. **Honest completion.** Only mark `completed` when the task is truly done. If tests are failing, the task is still `in_progress`. If you hit an error, add a new task describing what needs to be resolved.

5. **Verification step.** For non-trivial work, include a final "Verify" task. This might mean spawning a sub-agent to review, running tests, or checking the output file.

6. **Dynamic updates.** You can add, remove, or reorder tasks mid-flight. If you discover a task is unnecessary, remove it. If you discover a new subtask, add it. Always send the full updated list.

7. **Task granularity.** Tasks should be meaningful chunks, not individual tool calls. "Read 5 files" is too granular. "Analyze the authentication system" is the right level.

### 17.4 Host Rendering

The host application subscribes to todoWrite state and renders it. A minimal implementation:

```typescript
// In the host/CLI
import { currentTodos } from "./tools/todoWrite";

function renderTodos() {
  if (currentTodos.length === 0) return;

  console.log("\n--- Progress ---");
  for (const todo of currentTodos) {
    const icon = todo.status === "completed" ? "✓"
      : todo.status === "in_progress" ? "→"
      : "○";
    const dim = todo.status === "completed" ? "\x1b[2m" : "";
    const reset = "\x1b[0m";
    console.log(`${dim}  ${icon} ${todo.content}${reset}`);
  }

  const active = currentTodos.find(t => t.status === "in_progress");
  if (active) {
    console.log(`\n  ${active.activeForm}...`);
  }
  console.log("");
}

// Call renderTodos() after each agent step via onStepFinish
```

A GUI host would render this as a sidebar checklist widget with animated transitions.

### 17.5 Expanded Tool Implementation

```typescript
// src/tools/todoWrite.ts
import { tool } from "ai";
import { z } from "zod";

const todoSchema = z.object({
  content: z.string().min(1).describe("Imperative task description (e.g., 'Run the test suite')"),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().min(1).describe("Present continuous form shown during execution (e.g., 'Running the test suite')"),
});

// Shared state — the host reads this to render the widget
export let currentTodos: z.infer<typeof todoSchema>[] = [];

// Event emitter for host to subscribe to changes
type TodoListener = (todos: typeof currentTodos) => void;
const listeners: TodoListener[] = [];
export function onTodoChange(fn: TodoListener) { listeners.push(fn); }

export const todoWrite = tool({
  description: `Update the progress tracker for multi-step tasks. Sends the COMPLETE todo list each call (overwrite, not append).

Use this for virtually any task that involves tool calls. Users see this as a live checklist widget.

Rules:
- Create the list BEFORE starting work. Include all planned steps.
- Exactly ONE task should be in_progress at a time.
- Mark tasks completed IMMEDIATELY when done — don't batch.
- Only mark completed when truly finished (not if errors remain).
- Include a verification step as the final task for non-trivial work.
- Each item needs two forms: content ("Run tests") and activeForm ("Running tests").
- You can add, remove, or reorder tasks mid-flight as plans change.`,
  inputSchema: z.object({
    todos: z.array(todoSchema).describe("The complete, updated todo list"),
  }),
  execute: async ({ todos }) => {
    currentTodos = todos;
    listeners.forEach(fn => fn(todos));

    const summary = todos.map(t => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
      return `${icon} ${t.content}`;
    }).join("\n");
    return `Todo list updated:\n${summary}`;
  },
});
```

---

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
