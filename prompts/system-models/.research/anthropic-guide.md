# Anthropic Prompting Best Practices — Research Summary

Source: Anthropic official documentation at docs.anthropic.com (redirects to platform.claude.com/docs)
Compiled: 2026-02-12

---

## 1. System Prompt Structure and Best Practices

### Role Prompting (the most powerful system prompt technique)

Anthropic explicitly states that **role prompting is the most powerful way to use system prompts with Claude**. Key recommendations:

- Use the `system` parameter to set Claude's role. Put task-specific instructions in the `user` turn instead.
- Role prompting dramatically improves performance through:
  - **Enhanced accuracy** in complex scenarios (legal analysis, financial modeling)
  - **Tailored tone** (CFO's brevity vs. copywriter's flair)
  - **Improved focus** within task-specific requirements
- Experiment with roles — a "data scientist" sees different insights than a "marketing strategist." Specificity matters: "data scientist specializing in customer insight analysis for Fortune 500 companies" yields different results than just "data scientist."

### General System Prompt Advice

- System prompts should define the **role/persona** — everything else goes in user messages.
- Keep system prompts focused on identity, behavior rules, and constraints.
- Task-specific instructions should be in user turns, not the system prompt.

---

## 2. Formatting Conventions

### XML Tags (Highly Recommended by Anthropic)

Anthropic strongly recommends XML tags for structuring prompts. Key guidance:

- **No canonical "best" tag names** — use names that make sense for the content they surround (e.g., `<instructions>`, `<example>`, `<formatting>`, `<data>`, `<document>`)
- **Benefits**: Clarity (separation of prompt components), Accuracy (reduces misinterpretation), Flexibility (easy to modify parts), Parseability (post-processing extraction)

**Tagging best practices:**
1. **Be consistent**: Use the same tag names throughout prompts. Refer to tag names when discussing content: "Using the contract in `<contract>` tags..."
2. **Nest tags** for hierarchical content: `<outer><inner></inner></outer>`
3. **Combine with other techniques**: Use XML tags with multishot prompting (`<examples>`) or chain of thought (`<thinking>`, `<answer>`) for "super-structured, high-performance prompts"

**Specific tag patterns Anthropic uses in examples:**
- `<instructions>` — for step-by-step instructions
- `<data>`, `<contract>`, `<document>` — for input data
- `<formatting_example>` — for format reference
- `<findings>`, `<recommendations>` — for structured output sections
- `<thinking>`, `<answer>` — for chain-of-thought separation
- `<example>` / `<examples>` — for multishot examples
- `<document>` with `<source>` and `<document_content>` subtags — for multi-document inputs
- `<quotes>`, `<info>` — for grounded extraction tasks

### Long Context Formatting

- **Put longform data at the TOP** of the prompt, above queries, instructions, and examples. This can significantly improve performance across all models.
- **Queries at the end** can improve response quality by up to 30%, especially with complex multi-document inputs.
- Wrap each document in `<document>` tags with `<document_content>` and `<source>` subtags.
- For long document tasks, ask Claude to **quote relevant parts first** before carrying out its task — this helps cut through noise.

---

## 3. Core Prompting Techniques (Ordered by Effectiveness)

Anthropic orders techniques from most broadly effective to most specialized:

### 3.1 Be Clear and Direct
- Think of Claude as "a brilliant but very new employee (with amnesia) who needs explicit instructions"
- **The golden rule**: "Show your prompt to a colleague with minimal context. If they're confused, Claude will likely be too."
- Provide **contextual information**: what results will be used for, target audience, workflow position, success criteria
- Be specific about what you want Claude to do
- Provide instructions as **sequential steps** (numbered lists or bullet points)

### 3.2 Use Examples (Multishot Prompting)
- "Examples are your secret weapon shortcut for getting Claude to generate exactly what you need"
- Include **3-5 diverse, relevant examples** for best performance
- Examples must be: **Relevant** (mirror actual use case), **Diverse** (cover edge cases), **Clear** (wrapped in `<example>` tags, nested in `<examples>`)
- More examples = better performance, especially for complex tasks
- You can ask Claude to evaluate your examples for relevance, diversity, or clarity

### 3.3 Chain of Thought (CoT) Prompting
- Dramatically improves performance on complex tasks (math, logic, analysis)
- **Critical rule: "Always have Claude output its thinking. Without outputting its thought process, no thinking occurs!"**
- Three levels of CoT (least to most complex):
  1. **Basic**: "Think step-by-step" (lacks guidance on *how* to think)
  2. **Guided**: Outline specific steps for Claude to follow
  3. **Structured**: Use `<thinking>` and `<answer>` tags to separate reasoning from final answer

### 3.4 Chain Complex Prompts
- Break complex tasks into smaller, manageable subtasks
- Each subtask gets Claude's full attention, reducing errors
- Use XML tags for clear handoffs between prompts
- Each subtask should have a single, clear objective
- **Self-correction chains**: Have Claude review its own work — catches errors, especially for high-stakes tasks

---

## 4. Tool Use Best Practices

### Tool Descriptions (CRITICAL)

Anthropic states tool descriptions are **"by far the most important factor in tool performance"**. Detailed guidance:

- Descriptions should explain **every detail** about the tool:
  - What the tool does
  - When it should be used (and when it shouldn't)
  - What each parameter means and how it affects the tool's behavior
  - Important caveats or limitations
  - What information the tool does NOT return (if the tool name is unclear)
- **Aim for at least 3-4 sentences per tool description**, more for complex tools

**Good description example:**
```
"Retrieves the current stock price for a given ticker symbol. The ticker symbol must be a valid symbol for a publicly traded company on a major US stock exchange like NYSE or NASDAQ. The tool will return the latest trade price in USD. It should be used when the user asks about the current or most recent price of a specific stock. It will not provide any other information about the stock or company."
```

**Bad description example:**
```
"Gets the stock price for a ticker."
```

### Tool Use Examples (Beta Feature)

- Use `input_examples` field to provide schema-validated examples for complex tools
- Especially useful for tools with nested objects, optional parameters, or format-sensitive inputs
- Each example must be valid according to the tool's `input_schema`
- Token cost: ~20-50 tokens for simple examples, ~100-200 tokens for complex nested objects

### Model Selection for Tool Use

- **Claude Opus 4.6**: Recommended for complex tools and ambiguous queries. Handles multiple tools better and seeks clarification when needed. More likely to ask for missing required parameters.
- **Claude Haiku**: Use for straightforward tools. May infer missing parameters rather than asking.
- **Claude Sonnet**: May try to use tools as much as possible and may call unnecessary tools or infer missing parameters.

### Chain of Thought for Tool Use

For Sonnet and Haiku, Anthropic recommends this prompt to improve tool selection:

> "Answer the user's request using relevant tools (if they are available). Before calling a tool, do some analysis. First, think about which of the provided tools is the relevant tool to answer the user's request. Second, go through each of the required parameters of the relevant tool and determine if the user has directly provided or given enough information to infer a value. When deciding if the parameter can be inferred, carefully consider all the context to see if it supports a specific value. If all of the required parameters are present or can be reasonably inferred, proceed with the tool call. BUT, if one of the values for a required parameter is missing, DO NOT invoke the function (not even with fillers for the missing params) and instead, ask the user to provide the missing parameters. DO NOT ask for more information on optional parameters if it is not provided."

**Claude Opus is prompted by default to think before answering tool use queries.** Sonnet and Haiku are prompted to try to use tools as much as possible.

### Parallel Tool Use

- Claude can call multiple tools in parallel within a single response
- All `tool_result` blocks must be in a **single user message** (not separate messages)
- Tool results must come FIRST in the content array; any text must come AFTER

**Maximizing parallel tool use (for Claude 4 models), add to system prompt:**
```
For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.
```

**Stronger version:**
```
<use_parallel_tool_calls>
For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible.
</use_parallel_tool_calls>
```

### Forcing Tool Use

- `tool_choice: "auto"` — Claude decides (default)
- `tool_choice: "any"` — must use one tool
- `tool_choice: {"type": "tool", "name": "..."}` — must use specific tool
- `tool_choice: "none"` — cannot use tools

**Note:** `any` and `tool` choices are incompatible with extended thinking.

### Strict Tool Use (Structured Outputs)

- Add `strict: true` to tool definitions for guaranteed schema validation
- Eliminates missing parameters and type mismatches
- Combine with `tool_choice: "any"` for guaranteed calls with guaranteed schema conformance

---

## 5. Extended Thinking / Reasoning

### Claude Opus 4.6 Specific

For Claude Opus 4.6, Anthropic recommends **adaptive thinking** (`thinking: {type: "adaptive"}`) with the **effort parameter** instead of manual thinking mode. Manual `thinking: {type: "enabled", budget_tokens: N}` is **deprecated on Opus 4.6**.

### General Extended Thinking Best Practices

- Minimum budget is 1,024 tokens. Start at minimum and increase incrementally.
- For budgets above 32K, use batch processing to avoid networking issues.
- Extended thinking performs best in English (final outputs can be in any language).
- If you need thinking below the minimum budget, use standard mode with traditional `<thinking>` XML tags.

### Prompting Techniques for Extended Thinking

**Use general instructions first, then troubleshoot with more step-by-step instructions:**
- Claude often performs better with high-level instructions to "think deeply about a task" rather than step-by-step prescriptive guidance
- The model's creativity in approaching problems may exceed a human's ability to prescribe optimal thinking

**Instead of:**
```
Think through this math problem step by step:
1. First, identify the variables
2. Then, set up the equation...
```

**Use:**
```
Please think about this math problem thoroughly and in great detail.
Consider multiple approaches and show your complete reasoning.
Try different methods if your first approach doesn't work.
```

**Multishot prompting with extended thinking:**
- Works well — use XML tags like `<thinking>` or `<scratchpad>` in examples
- Claude will generalize the pattern to the formal extended thinking process
- However, giving Claude free rein to think its own way may yield better results

**Maximizing instruction following:**
- Claude shows significantly improved instruction following with extended thinking enabled
- Be clear and specific about what you want
- For complex instructions, break into numbered steps
- Allow enough budget to process instructions fully

**Debugging with thinking output:**
- Use thinking output to debug Claude's logic (not always perfectly reliable)
- Do NOT pass Claude's extended thinking back in the user text block (doesn't improve performance, may degrade results)
- Prefilling extended thinking is explicitly not allowed
- Manually changing output text after thinking blocks degrades results

**Reflection and self-checking:**
- Ask Claude to verify its work with test cases before declaring done
- Instruct the model to analyze whether previous steps achieved expected results
- For coding tasks, ask Claude to run through test cases in extended thinking

### Interleaved Thinking with Tools

- Claude Opus 4.6: Automatically enabled with adaptive thinking (no beta header needed)
- Other Claude 4 models: Requires beta header `interleaved-thinking-2025-05-14`
- Allows Claude to reason between tool calls and make more sophisticated decisions after receiving tool results
- With interleaved thinking, `budget_tokens` can exceed `max_tokens` as it represents total budget across all thinking blocks within one assistant turn

---

## 6. Model-Specific Recommendations

### Claude Opus 4.6
- Most capable model. Use for complex reasoning, multi-step analysis, ambiguous queries
- Recommended: adaptive thinking (`thinking: {type: "adaptive"}`) with effort parameter
- Manual thinking mode (`budget_tokens`) is deprecated
- Supports up to 128K output tokens
- Excels at parallel tool use with minimal prompting
- More likely to ask for clarification when tool parameters are missing
- Thinking blocks from previous assistant turns are **preserved in model context by default**
- Interleaved thinking is automatic with adaptive thinking

### Claude Haiku 4.5
- Optimized for speed and efficiency
- Use for straightforward tools and simple tasks
- May infer missing parameters rather than asking for clarification
- Less likely to use parallel tools without explicit prompting
- Benefits from the chain-of-thought tool use prompt (see Section 4)
- For complex tool selection, add explicit thinking instructions before tool calls
- Prompted to try to use tools as much as possible — may call unnecessary tools

### Key Differences (Opus vs Haiku)
1. **Tool use**: Opus thinks before calling tools by default; Haiku/Sonnet try to use tools aggressively
2. **Missing parameters**: Opus asks for clarification; Haiku infers/guesses
3. **Parallel tools**: Opus excels with minimal prompting; Haiku needs explicit instructions
4. **Extended thinking**: Opus supports adaptive thinking; Haiku supports manual budget
5. **Reasoning depth**: Opus benefits from "think deeply" prompts; Haiku benefits from explicit step-by-step guidance

---

## 7. Additional Patterns and Tips

### Structured Output with XML
- Use `<thinking>` and `<answer>` tags to separate reasoning from response
- Ask Claude to use specific output tags (`<findings>`, `<recommendations>`, etc.)
- Makes post-processing and extraction much easier

### Grounding in Quotes
- For long document tasks, ask Claude to quote relevant parts first
- Place quotes in `<quotes>` tags, then work from them
- Reduces hallucination and improves accuracy on retrieval tasks

### Self-Correction Chains
- Generate → Review → Refine → Re-review
- Each step in a separate prompt for maximum attention
- Particularly effective for high-stakes outputs

### Handling Ambiguity
- Opus is much more likely to recognize missing information and ask
- Sonnet/Haiku may guess — use the CoT tool use prompt to improve this
- Be explicit in system prompts about when to ask vs. when to proceed

### Token Efficiency
- Tool definitions add tokens to every request (tool names, descriptions, schemas)
- Claude 4 models have built-in token-efficient tool use
- When using thinking, Claude 4 models return summarized thinking (full thinking tokens are still billed)
- Thinking blocks from previous turns are stripped from context (except Opus 4.5+ which preserves them)

---

## 8. Key Quotes from Documentation

> "Think of Claude as a brilliant but very new employee (with amnesia) who needs explicit instructions."

> "The golden rule of clear prompting: Show your prompt to a colleague, ideally someone who has minimal context on the task, and ask them to follow the instructions. If they're confused, Claude will likely be too."

> "Always have Claude output its thinking. Without outputting its thought process, no thinking occurs!"

> "Provide extremely detailed descriptions. This is by far the most important factor in tool performance."

> "Claude often performs better with high level instructions to just think deeply about a task rather than step-by-step prescriptive guidance. The model's creativity in approaching problems may exceed a human's ability to prescribe the optimal thinking process."

> "We recommend using adaptive thinking (thinking: {type: 'adaptive'}) with the effort parameter instead of the manual thinking mode described on this page. The manual thinking: {type: 'enabled', budget_tokens: N} configuration is deprecated on Opus 4.6."

> "Use the system parameter to set Claude's role. Put everything else, like task-specific instructions, in the user turn instead."

> "For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially."
