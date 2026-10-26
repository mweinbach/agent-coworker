# Pi & Local Models Prompting and Harness Best Practices — Research Summary

Compiled from `@earendil-works/pi-ai` (`1.0.1`), `@earendil-works/pi-coding-agent`, Mario Zechner's Pi architecture write-ups, Databricks' coding-agent harness benchmark findings, and 2025–2026 local LLM runtime guidance (LM Studio, `llama.cpp`, Ollama, vLLM, and GGUF/MLX quantized models such as Qwen3, Qwen2.5-Coder, Gemma 4, DeepSeek-R1 distills, and Nemotron).

---

## 1. Why Local Models Need a Dedicated Prompt and Harness Profile

Cloud frontier models have 200k–1M token context windows, massive server-side KV-cache capacity, and high instruction-following tolerance for 10,000+ token system prompts. Local models running in LM Studio, `llama.cpp`, or Ollama operate under fundamentally different constraints:

1. **Tight Context Windows (4k–64k tokens)**:
   - Even when a model's training context is 128k, local users frequently load models at 8k, 16k, or 32k context in LM Studio or `llama.cpp` (`-c 32768`) to fit KV cache in unified memory or consumer VRAM.
   - A 20k+ character system prompt plus verbose skill/subagent catalogs consumes 5,000–8,000 tokens before the first user message, leaving almost no room for file reads, tool outputs, and multi-step reasoning.
2. **Prefill Latency & KV-Cache Pressure**:
   - On Apple Silicon (MLX / Metal) and consumer GPUs, every extra thousand tokens of uncached or invalidated system/tool context adds measurable time-to-first-token (TTFT) and memory bandwidth pressure.
3. **Instruction Dilution ("Lost in the Middle")**:
   - Smaller and quantized models (7B–32B Q4/Q5/Q8) degrade sharply when the system prompt repeats the same rules three times in long conversational paragraphs.
   - Pi's core thesis — validated by external coding-agent benchmarks — is that compact, high-signal system prompts and lean tool definitions reduce per-turn context by ~3x while improving pass rates and tool-call reliability.

---

## 2. System Prompt Best Practices for Local Models (Pi Style)

### 2.1 Single-Pass, Non-Redundant Structure

- **State each rule once**: Avoid repeating tool rules across `# Tools`, `# Planning`, `# Detailed Guidelines`, `# Working with the User's Computer`, and `# Decision Examples`.
- **Direct, imperative bullets**: Replace multi-paragraph prose explanations with crisp, verifiable rules under clear headings (`# Environment`, `# Core Rules`, `# Tools`, `# Planning & Delegation`, `# Safety`).
- **Preserve exact tool contracts**:
  - Always use the exact registered tool names (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `webSearch`, `webFetch`, `AskUserQuestion`, `todoWrite`, `spawnAgent`, `skill`, `memory`).
  - Keep critical operational invariants explicit: read before `edit`/`write` on existing files, `columnOffset` for lines > 2,000 chars, binary media guard (audio/video/PDF not returned by `read`), `todoWrite` full-list replacement contract, and `skill` loading before deliverable creation.

### 2.2 Compact Dynamic Prompt Sections

- **Skills Catalog**:
  - Full skill catalog entries with filesystem paths (`location: /.../SKILL.md`) and verbose trigger lists bloat the prompt when dozens of skills are installed.
  - Because the `skill` tool loads skills by canonical `name`, local models only need `- **<name>**: <concise description>` in `## Available Skills` and do not need duplicate per-skill example lists when the template already includes `{{skillExamples}}`.
- **Workspace Map**:
  - Cap the injected directory tree more tightly for local models (`~1,600` chars instead of `4,000` chars) so top-level project structure is visible without burning 1,000+ tokens.

---

## 3. Pi (`@earendil-works/pi-ai`) Harness Best Practices for Local Models

### 3.1 OpenAI-Completions Compatibility (`OpenAICompletionsCompat`)

Local servers (`lmstudio`, `llama-server --jinja`, Ollama, vLLM) speak OpenAI Chat Completions with important differences from `api.openai.com`:

- **`supportsStore: false`**: Local servers do not support OpenAI's `store` parameter and may reject unknown fields.
- **`supportsDeveloperRole: false`**: Many local chat templates (Jinja templates in GGUF/MLX models) only recognize `system`, `user`, `assistant`, and `tool` roles; sending `developer` causes template errors or dropped instructions.
- **`supportsReasoningEffort: false`**: Unless explicitly configured for a compatible server, `reasoning_effort` is unsupported by generic local endpoints.
- **`supportsStrictMode: false`**: OpenAI `strict: true` requires every property in `required` and `additionalProperties: false`, which breaks optional tool parameters unless schemas are rewritten. Local servers use their own grammar engines (`--jinja` / GBNF / llguidance) over standard JSON Schema.
- **`supportsFinishReason: false`**: Some local OpenAI-compatible servers close streamed tool-call or text responses without emitting a final `finish_reason` chunk. In `@earendil-works/pi-ai`, setting `supportsFinishReason: false` preserves any `finish_reason` the server *does* send while gracefully inferring `"toolUse"` (when tool calls were emitted) or `"stop"` if the stream ends without one.
- **`requiresToolResultName: true`**: Many local model Jinja chat templates (Qwen, Mistral, Hermes, Gemma) read `message.name` on `role: "tool"` messages to format tool results.
- **`maxTokensField: "max_tokens"`**: Local servers consistently support `max_tokens` (and some reject `max_completion_tokens`).

### 3.2 Grammar-Safe Tool JSON Schemas

- Local engines (`llama.cpp`, LM Studio, vLLM, SGLang) compile tool JSON Schemas into constrained-decoding grammars (GBNF / llguidance).
- Schema keywords like `maxLength: 2000000`, `minLength`, `maxItems`, `minItems`, `pattern`, and top-level `oneOf` can cause slow grammar compilation or schema rejection on local servers.
- Strip those constraint keywords from the wire schema sent to `lmstudio` (normalizing `oneOf` to `anyOf`) while keeping all property names, types, enums, descriptions, and `required` arrays intact, and enforce the full Zod schema in-process before tool execution.

### 3.3 Null Optional Parameter Normalization

- Local models (especially when constrained by JSON-schema grammars or trained on Hermes/Qwen/Gorilla tool datasets) frequently emit explicit `null` values for optional or defaulted parameters they do not intend to use (for example `{"filePath": "/a.ts", "offset": null, "limit": null}`).
- Normalize `null` values on optional/defaulted fields to `undefined` when validating tool inputs so valid tool calls succeed on the first attempt instead of failing Zod validation and triggering retry loops.

### 3.4 Inline `<think>...</think>` Extraction & Multi-Step Replay Hygiene

- Local reasoning models (Qwen3, DeepSeek-R1 distills, Qwen2.5, Gemma 4, Nemotron, Cogito) often emit `<think>...</think>` tags inline inside `delta.content` when the local server or chat template does not separate `reasoning_content`.
- Split `<think>...</think>` out of `text-delta` events into `reasoning-start` / `reasoning-delta` / `reasoning-end` stream parts and convert them to `{ type: "thinking", thinking }` blocks on the completed assistant record.
- In `@earendil-works/pi-ai`, unsigned `thinking` blocks are omitted when replaying prior assistant messages to `openai-completions`, matching Qwen3 / DeepSeek-R1 chat-template best practices and saving thousands of context tokens across multi-step tool loops.

### 3.5 Context-Window-Aware `maxTokens` Clamping, History Pruning, and Tool Output Overflow

1. **`maxTokens` Clamping**:
   - Local servers reject requests when `prompt_tokens + max_tokens > context_length`.
   - Use `@earendil-works/pi-ai/utils/estimate` (`estimateContextTokens`) on the normalized transcript to clamp `maxTokens` to the remaining context window (with a proportional safety margin) and forward `maxTokens` in the stream options.
2. **Context-Budget Transcript Pruning**:
   - When a multi-turn or multi-step conversation's estimated tokens exceed the local model's input context budget, prune the oldest complete turn groups from `piMessages` while preserving `assistant` tool-call and `toolResult` pairing and keeping the active turn tail intact.
3. **Context-Scaled Tool Output Overflow**:
   - The default 25,000-character inline tool output threshold (~7,100 tokens) is safe for 200k-context cloud models but can exhaust an 8k–16k local model's context in a single `bash` or `grep` call.
   - When `toolOutputOverflowChars` is not explicitly configured, scale the default overflow threshold to the local model's `contextWindow` (for example ~20% of the context window in characters, clamped between `4,000` and `25,000` chars) so large outputs spill to `.ModelScratchpad` early and keep the model's context window healthy.
