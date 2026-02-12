# OpenAI Prompting Best Practices — Research Summary

Compiled from official OpenAI documentation, the GPT-5.2 Prompting Guide (OpenAI Cookbook, Dec 2025), the GPT-4.1 Prompting Guide, OpenAI Help Center, and Azure OpenAI documentation. This research directly informs system prompt optimization for GPT-5.2.

---

## 1. Message Roles and Authority Hierarchy

OpenAI defines a strict three-tier message hierarchy:

- **Developer role** (formerly "system"): System-level instructions with the **highest priority**. Comparable to function definitions — the model treats these as authoritative behavioral constraints.
- **User role**: End-user inputs with **lower priority** than developer messages. Like function arguments.
- **Assistant role**: Model-generated responses.

**Key change for reasoning models (o1+, GPT-5 series):** Starting with `o1-2024-12-17`, reasoning models support **developer messages rather than system messages**, aligning with chain-of-command behavior per the model spec. Replace traditional `system` role with `developer` role.

The `instructions` parameter in the Responses API provides high-level behavioral guidance (tone, goals, response examples) and takes priority over input prompts.

---

## 2. System Prompt Structure — Recommended Architecture

OpenAI recommends organizing developer/system messages in this specific sequence:

1. **Identity**: Purpose, communication style, goals
2. **Instructions**: Rules, dos/don'ts, task-specific guidance (e.g., function-calling details)
3. **Examples**: Sample inputs paired with desired outputs
4. **Context**: Supporting data, proprietary information, domain-specific knowledge (positioned near end)

### GPT-5.2 Specific: XML-Style Labeled Blocks

The GPT-5.2 guide introduces composable, labeled XML-style blocks for system prompts:

- `<output_verbosity_spec>` — Length guidance and formatting preferences
- `<design_and_scope_constraints>` — Feature boundaries and scope discipline
- `<long_context_handling>` — Dense document workflow instructions
- `<uncertainty_and_ambiguity>` — Hallucination prevention rules
- `<tool_usage_rules>` — Agentic tool calling patterns
- `<extraction_spec>` — Structured data extraction schemas
- `<user_updates_spec>` — Progress communication patterns
- `<web_search_rules>` — Research workflow guidance
- `<high_risk_self_check>` — Compliance-sensitive task handling

These sections work as reusable, composable modules.

---

## 3. Formatting Conventions

### Use Markdown and XML Together

From the official prompt engineering guide:

- Use **Markdown headers and lists** to mark distinct sections and communicate hierarchy
- Deploy **XML tags** to delineate content boundaries (e.g., supporting documents, examples)
- Apply **XML attributes** for metadata referencing within instructions
- This improves both model understanding and developer readability

### Delimiter Best Practices

From the GPT-4.1 guide and Help Center:

- Put instructions at the **beginning** of the prompt
- Use `###` or `"""` to separate instruction from context
- **Markdown** is ideal for headings and clarity
- **XML** is best for structured documents or nested elements
- **Avoid JSON** for input formatting — too verbose and poorly suited for prompt structure
- Use delimiters consistently throughout the prompt

### GPT-5.2 Verbosity Control

GPT-5.2 has lower default verbosity but is still prompt-sensitive. Implement explicit length constraints:

- Simple queries: ≤2 sentences
- Standard responses: 3-6 sentences or ≤5 bullets
- Complex multi-step: 1 overview paragraph + ≤5 tagged bullets (What changed, Where, Risks, Next steps, Open questions)

---

## 4. Instruction Writing Best Practices

### From the Official Guide

1. **Write clear, specific instructions** — Don't assume the model will infer what you want
2. **Tell the model what TO do**, not just what to avoid
3. **Give the model a role** — "You are an expert copywriter..." establishes behavioral framing
4. **Be specific about format, length, and style**
5. **Use the latest model** — Newer models are easier to prompt engineer

### GPT-5.2 / GPT-4.1 Specific

These models follow instructions **more literally** than predecessors:

> "Since the model follows instructions more literally, developers may need to include explicit specification around what to do or not to do. Furthermore, existing prompts optimized for other models may not immediately work with this model, because existing instructions are followed more closely and implicit rules are no longer being as strongly inferred."

This means:
- Be explicit about edge cases and fallback behavior
- Don't rely on the model to "fill in the gaps" — state everything
- A single clarifying sentence can significantly improve output quality
- Test prompts that worked on older models — they may behave differently

---

## 5. Chain-of-Thought and Reasoning Guidance

### For GPT-5.2 (Completion Model with Optional Reasoning)

GPT-5.2 is **not a reasoning model by default** but can be induced to reason:

- Use chain-of-thought (CoT) techniques: "Break the query down step by step", "Reflect on what was learned after each tool call", "Only act once you're confident in the next step"
- **Planning induction**: GPT-5.2 excels when given the chance to plan. Prompt it to think step-by-step or generate an outline first before executing
- Control reasoning effort via the `reasoning_effort` parameter:
  - `none` — Preserve snappy behavior (default for most tasks)
  - `minimal` — Light reasoning
  - Higher settings for complex tasks

### For Reasoning Models (o-series, GPT-5 in reasoning mode)

**What NOT to do:**
- **Do NOT instruct "think step by step"** or "explain your reasoning" — these models reason internally and such prompts are unnecessary/counterproductive
- **Do NOT use few-shot examples without alignment** — Discrepancies between examples and instructions produce poor results
- **Do NOT assume markdown formatting** — Reasoning models avoid markdown by default. Use `Formatting re-enabled` on the first line if you want markdown

**What TO do:**
- Keep prompts **simple and direct**
- Use **delimiters** for clarity (markdown, XML tags, section titles)
- Try **zero-shot first** — reasoning models often don't need few-shot examples
- Provide **specific constraints** — explicitly outline limitations
- Be very specific about **success criteria**

---

## 6. Function Calling / Tool Use Best Practices

### Tool Description Guidelines

From the official function calling guide:

- **Name tools clearly** to indicate their purpose
- Add a **clear, detailed description** in the "description" field
- For each parameter, use **good naming and descriptions** to ensure appropriate usage
- If a tool is particularly complicated, create an `# Examples` section in your **system prompt** (not in the description field)
- Descriptions should remain thorough but relatively concise

### The "Intern Test"

> "Can an intern/human correctly use the function given nothing but what you gave the model?" If not, add clarifying details.

### Software Engineering Principles for Tool Design

- **Intuitive design**: Follow the principle of least surprise
- **Use enums for invalid states**: Structure parameters to make invalid combinations unrepresentable
- **Offload burden to code**: Don't make the model fill arguments you already possess. Remove parameters you can supply programmatically
- **Combine sequential functions**: If functions are always called together, consolidate them
- **Limit function count**: Aim for **fewer than 20 functions** at any one time

### Tool Choice Configuration

- **Auto** (default): Model determines when to call zero, one, or multiple functions
- **Required**: Forces at least one function call
- **Specific function**: Forces exactly one particular function
- **Allowed tools**: Restrict calls to a subset without modifying the full tools list (useful for prompt caching)

### Strict Mode

Set `strict: true` to ensure function calls reliably adhere to the schema:
- `additionalProperties` must be `false` for each object
- All fields in `properties` must be marked `required`
- Optional fields use `null` as an additional type option

### Parallel Function Calling

- The model may call multiple functions in one turn
- Disable with `parallel_tool_calls: false` to ensure zero or one call per response
- Parallel calling is unavailable when using built-in tools

### Token Optimization

Functions are injected into system messages and count against context limits. If you hit token constraints:
- Reduce function count
- Shorten parameter descriptions
- Consider fine-tuning for complex scenarios

### GPT-5.2 Tool Usage Patterns

Structure tool guidance through `<tool_usage_rules>` sections:
- Prefer tool calls for fresh data over internal knowledge
- **Parallelize independent reads** (file access, record fetching, doc searches) for latency reduction
- Require explicit restatement after write/update operations: what changed, location (ID/path), validation performed
- Use **crisp tool descriptions** (1-2 sentences defining purpose and invocation triggers)

---

## 7. Structured Outputs

### Three Approaches (in order of recommendation)

1. **Structured Outputs via `response_format`** (strict schema enforcement): Use when you need the model's output itself to conform to a schema. GPT-5.2 uses a **Context-Free Grammar (CFG) engine** to mask invalid tokens before generation — 100% schema compliance guaranteed.

2. **Structured Outputs via function calling** (strict schema enforcement): Use when connecting the model to tools/functions that require structured invocation data.

3. **JSON Mode** (legacy): Only validates JSON syntax, NOT schema adherence. Use only for older models.

### Strict Mode Requirements

- All properties must be explicitly defined
- Set `additionalProperties: false`
- Include `required` arrays for all mandatory properties
- Use specific types (string, array, object, number, boolean)

### Refusal Handling

Structured Outputs adds a new failure mode: the model may return a **refusal object** instead of JSON. Always check `message.refusal` before parsing.

### Prompting Tips for Structured Outputs

- Schema enforcement replaces complex formatting instructions — simpler prompts work better
- Use arrays of step objects to guide reasoning through complex problems
- For extraction: provide exact JSON schema, distinguish required vs optional, instruct to set missing fields to `null` rather than guessing

---

## 8. Agentic Workflow Patterns

### GPT-4.1/5.2 Three-Part Agent Template

From the GPT-4.1 guide (applicable to GPT-5.2):

1. **Persistence**: "Keep going until the problem is resolved."
2. **Tool-Calling**: "Use tools when uncertain. Do not guess."
3. **Planning**: "Think and plan before acting."

This structure boosted SWE-bench Verified scores by over 20%.

### GPT-5.2 Agentic Steerability

Updated `<user_updates_spec>` patterns:
- Restrict updates to 1-2 sentences
- Trigger only on major phase starts or plan-changing discoveries
- Omit routine tool narration ("reading file...", "running tests...")
- Require concrete outcomes per update ("Found X", "Confirmed Y", "Updated Z")
- Explicitly forbid task scope expansion; flag new work as optional

### Scope Discipline

Use `<design_and_scope_constraints>` blocks specifying:
- "Implement EXACTLY and ONLY what the user requests"
- No extra features, unattributed components, or UX embellishments
- Restriction to existing tokens/colors unless explicitly requested

---

## 9. Long Context Handling

GPT-5.2 handles large contexts but requires proper structure:

- **Instructions at the top AND bottom** of the prompt work best
- Minimize irrelevant context to reduce token fatigue
- Explicitly control reliance on internal vs. external knowledge
- For inputs exceeding ~10k tokens, employ **forced summarization**:
  - Generate short internal outlines of relevant sections
  - Restate user constraints explicitly before answering
  - Anchor claims to source sections rather than speaking generically
  - Quote or paraphrase fine details when answers depend on them

---

## 10. Hallucination & Ambiguity Mitigation

### Uncertainty Handling Block

Include in system prompts:
- Explicit callouts when questions lack specificity
- 1-3 clarifying questions OR 2-3 plausible interpretations with labeled assumptions
- Qualification language for external facts: "Based on provided context..."
- Avoidance of fabricated figures, line numbers, or references when uncertain

### High-Risk Self-Check

For legal/financial/safety contexts:
- Instruct model to rescan answers for unstated assumptions
- Check for ungrounded numbers
- Flag overly strong language ("always", "guaranteed")
- Soften claims when discovered

---

## 11. GPT-5.2 Migration Guidance

### From Prior Models

| Current Model | Target | Reasoning Effort | Notes |
|--------------|--------|------------------|-------|
| GPT-4o/4.1 | GPT-5.2 | none | Preserve snappy behavior by default |
| GPT-5 | GPT-5.2 | same (minimal→none) | Maintain latency/quality profile |
| GPT-5.1 | GPT-5.2 | same | Adjust only post-eval |

### Migration Sequence

1. Switch models without prompt changes (test model only)
2. Pin `reasoning_effort` matching prior latency profile
3. Run baseline evals
4. If regressions appear, apply targeted prompt constraints
5. Re-evaluate after each incremental change

---

## 12. Compaction for Extended Workflows

The `/responses/compact` endpoint preserves task-relevant information in encrypted, opaque format for multi-step agent flows.

Best practices:
- Compact after major milestones (tool-heavy phases), not every turn
- Monitor context usage proactively
- Maintain identical prompts when resuming to prevent behavior drift
- Treat compacted items as opaque; don't parse internals

---

## 13. Web Search and Research Patterns

Implement `<web_search_rules>` specifying:
- Comprehensive coverage as default with citations for all web-derived claims
- Research continuation until marginal value diminishes
- Breadth-first approach covering all plausible query interpretations
- Markdown formatting with headers, bullets, tables for comparisons
- Citation requirements: place after paragraphs, use multiple sources, prioritize primary sources

---

## 14. Key Differences: GPT-5.2 vs Previous Models

1. **Lower verbosity** — Naturally more concise, but still prompt-sensitive
2. **Stronger instruction adherence** — More literal interpretation of instructions
3. **Conservative grounding bias** — Favors correctness and explicit reasoning
4. **Deliberate scaffolding** — Builds clearer intermediate structures
5. **CFG engine for structured outputs** — 100% schema compliance at the token level
6. **Composable XML blocks** — New pattern for modular system prompt sections
7. **Scope discipline** — Better at staying within requested boundaries when instructed

---

## Sources

- OpenAI Prompt Engineering Guide: https://developers.openai.com/api/docs/guides/prompt-engineering
- GPT-5.2 Prompting Guide (OpenAI Cookbook): https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide
- GPT-4.1 Prompting Guide (OpenAI Cookbook): https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide
- OpenAI Function Calling Guide: https://developers.openai.com/api/docs/guides/function-calling
- OpenAI Structured Outputs Guide: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI Reasoning Best Practices: https://developers.openai.com/api/docs/guides/reasoning-best-practices
- OpenAI Help Center - Prompt Engineering: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api
- Azure OpenAI System Message Design: https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/advanced-prompt-engineering
