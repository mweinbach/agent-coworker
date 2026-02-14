# Google Gemini Prompting Best Practices — Research Summary

Compiled from official Google documentation (ai.google.dev, cloud.google.com/vertex-ai, Google AI blog) and authoritative third-party analyses. This research covers Gemini 3 Flash and Gemini 3 Pro models.

---

## 1. System Instruction Structure and Formatting

### Recommended Structure

Google's official Gemini 3 prompting guide recommends using **consistent delimiters** — either XML tags or Markdown sections — throughout a single prompt. Do not mix delimiter styles within the same prompt.

**XML tag structure** (preferred for complex system prompts):
```
<role>Assistant identity and expertise</role>
<constraints>Behavioral limitations</constraints>
<context>Background information</context>
<task>Specific user request</task>
```

**Markdown structure** (alternative):
```
# Identity
...
# Constraints
...
# Output Format
...
```

Key structural principles from Google's docs:

- **"State your goal clearly and concisely. Avoid unnecessary or overly persuasive language."** — Gemini 3 is more concise by default and responds poorly to verbose, over-explained instructions.
- Position critical instructions in system prompts or at the prompt opening.
- Supply large context blocks first, followed by specific questions.
- Bridge large data sections with anchoring phrases like "Based on the information above..."
- Place negative constraints, formatting rules, and quantitative constraints at the END of instructions — placing them early causes "constraint dropout" where the model forgets them.

### Gemini 3 Is Concise by Default

Google explicitly notes: "By default, Gemini 3 prioritizes efficiency over conversational tone." If you want verbose/chatty responses, you must explicitly instruct: "Explain this as a friendly, talkative assistant." Otherwise, Gemini 3 will be terse and direct.

This is a significant difference from models that default to verbose output — system prompts for Gemini should NOT include instructions to "be concise" (it already is), but SHOULD include instructions for verbosity when needed.

### Persona Usage

Google warns that Gemini 3 "takes assigned personas seriously, sometimes prioritizing them over conflicting instructions." Example from docs: "You are a data extractor. You are forbidden from clarifying, explaining, or expanding terms." — The persona will dominate behavior, so ensure the persona description doesn't conflict with other instructions.

---

## 2. Temperature and Model Parameters

### Critical: Keep Temperature at 1.0

This is Google's strongest and most repeated recommendation for Gemini 3:

> "When using Gemini 3 models, we strongly recommend keeping the temperature at its default value of 1.0."

> "Gemini 3's reasoning capabilities are optimized for the default temperature setting and don't necessarily benefit from tuning temperature."

> "Lowering temperature below 1.0 may cause unexpected behavior, looping, or degraded performance, particularly with complex mathematical or reasoning tasks."

**This is critical for our agent.** If we're setting temperature in provider config, it MUST be 1.0 for Gemini 3 models.

### Other Parameters

- **topK**: Selects next token from K most probable options; topK=1 means greedy decoding.
- **topP**: Default 0.95. Samples tokens until cumulative probability reaches threshold.
- **stop_sequences**: Terminate generation at specified character sequences.
- **Max output tokens**: ~100 tokens equals 60-80 words.

### Latency Optimization

For faster responses, set thinking level to `LOW` and use system instructions like "think silently" to reduce visible reasoning overhead.

---

## 3. Few-Shot Examples

Google's official recommendation:

> "We recommend to always include few-shot examples in your prompts. Prompts without few-shot examples are likely to be less effective."

Key practices:
- Models typically learn patterns from a few examples; excessive examples risk overfitting.
- Use **positive examples** showing desired behavior rather than anti-patterns.
- Maintain **identical structure and formatting** across all examples.
- Use input/output prefixes for clarity (e.g., "Input:", "Output:", "English:", "French:").

---

## 4. Prompt Decomposition

For complex tasks, Google recommends:

- **Break complex instructions** into separate prompts rather than combining multiple requirements.
- **Chain prompts sequentially** where each prompt's output becomes the next prompt's input.
- **Aggregate responses** by executing parallel operations on different data portions and combining results.

---

## 5. Function Calling / Tool Use Best Practices

### Function Declaration Quality

Google emphasizes being **"extremely clear and specific in your descriptions"** because model tool selection depends heavily on these descriptions.

**Naming conventions:**
- Use descriptive, clear names without spaces, periods, or dashes.
- Prefer underscores or camelCase: `get_weather_forecast` not `GetWeatherForecast`.

**Description quality:**
- Include concrete usage examples in descriptions: "Finds theaters based on location and optionally movie title which is currently playing in theaters."
- Assign specific data types (string, integer, boolean, array) to reduce errors.
- For fixed value sets, use `enum` arrays instead of text descriptions: `"enum": ["daylight", "cool", "warm"]`.
- Always list required parameters in a `required` array.
- Include constraint information in parameter descriptions.

### Function Calling Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **AUTO** (Default) | Model independently decides whether to generate text or call functions | Default for conversational scenarios |
| **ANY** | Model must always predict a function call; use `allowed_function_names` to restrict | Guarantees execution; useful for structured workflows |
| **NONE** | Prohibits function calls without removing tool definitions | Pure text generation |
| **VALIDATED** (Preview) | Ensures function schema adherence while permitting text responses | Schema validation |

### Parallel and Compositional Calling

- **Parallel**: Multiple independent functions execute simultaneously when they don't depend on each other.
- **Compositional**: Chaining multiple function calls where outputs feed into subsequent inputs across conversation turns.

### Tool Count Recommendations

> "Providing too many functions increases incorrect selections. Maintain active tool sets between 10-20 maximum; implement dynamic selection based on conversation context for larger libraries."

**This is directly relevant to our agent** which has a large tool set. Consider dynamic tool selection or grouping for Gemini models.

### Temperature for Function Calling

For deterministic, reliable function calls, Google historically recommended low temperature values. However, for Gemini 3 specifically, the override applies: keep temperature at 1.0 to avoid looping or degraded performance.

### Error Handling

- Implement robust error handling within functions to gracefully manage unexpected inputs.
- Return informative error messages enabling the model to generate helpful user responses.
- Always check the `finishReason` field to identify cases where the model failed generating valid function calls.
- The model can learn from error responses and adjust subsequent function calls accordingly.

### System Instruction Patterns for Tool Use

From Google's Barista Bot agent example, the recommended pattern is:
- Include available data/options (menu items, available tools) in system instructions.
- Specify interaction guidelines: "Always `confirm_order` before calling `place_order`".
- Define when and how to use functions explicitly.
- Encourage clarification-seeking when needed.
- Maintain validation steps for high-consequence operations before execution.

---

## 6. Structured Output / JSON Mode

### Configuration

Set two parameters:
- `response_mime_type`: `"application/json"`
- `response_json_schema`: Your JSON Schema definition

### Schema Best Practices

- Use detailed `description` fields to guide model behavior.
- Leverage `enum` for classification tasks with limited options.
- Implement application-level validation despite schema compliance.
- Simplify deeply nested schemas if you encounter rejection errors.
- Supports Pydantic (Python) and Zod (JavaScript) for schema definitions.
- Streaming is supported: "The streamed chunks will be valid partial JSON strings."

### Supported Types

`string`, `number`, `integer`, `boolean`, `object`, `array`, `null` (via type array).

### Constraints Available

- `enum` for fixed values
- `format` for date-time, date, time
- `minimum`/`maximum` for numbers
- `minItems`/`maxItems` for arrays
- `required` for mandatory fields
- `additionalProperties` for objects

### Limitations

> "Not all features of the JSON Schema specification are supported. The model ignores unsupported properties."

Very large or deeply nested schemas may be rejected by the API.

---

## 7. Grounding and Accuracy

### Custom Context Grounding

When providing context the model should treat as authoritative:

> "Treat the provided context as the absolute limit of truth; any facts or details not directly mentioned must be considered completely unsupported."

### Current Date Awareness

Add to system instructions:
- "Remember it is 2025 this year" (or current year)
- "Your knowledge cutoff date is January 2025"

### Two-Step Verification Pattern

For tasks where the model might hallucinate:
1. First verify capability/information exists.
2. If verified, proceed; otherwise state "No Info" and stop.

### Grounding Declaration

> "You are a strictly grounded assistant limited to the information provided."

---

## 8. Agentic Workflow Configuration

Google provides specific guidance for configuring agent behavior in system prompts:

### Reasoning Dimensions
- Control logical decomposition depth
- Problem diagnosis approaches
- Information exhaustiveness trade-offs

### Execution Dimensions
- Configure adaptability to new data
- Persistence/recovery attempts
- Risk assessment logic distinguishing exploratory versus state-changing actions

### Interaction Dimensions
- Set ambiguity tolerance
- Clarification requirements
- Verbosity levels
- Precision expectations

### Recommended Agentic System Instruction Pattern

> "Before taking any action...you must proactively, methodically, and independently plan and reason about" logical dependencies, risk assessment, hypothesis exploration, outcome evaluation, information availability, precision, completeness, and persistence requirements.

---

## 9. Gemini 3 Flash vs Pro — Model-Specific Differences

### Gemini 3 Flash

- **Optimized for**: Speed, throughput, cost efficiency
- **Context window**: Up to 1M tokens input
- **Pricing**: ~$0.50/1M input tokens, ~$3.00/1M output tokens
- **Speed**: ~3x faster throughput than Gemini 2.5 Pro baselines
- **Thinking tokens**: Uses ~30% fewer thinking tokens than Gemini 2.5 Pro
- **GPQA Diamond**: 90.4% (approaching Pro accuracy)
- **Best for**: Interactive chat, high-throughput summarization, coding autocomplete, bulk testing, consumer apps

**Prompting differences for Flash:**
- Responds well to shorter, more direct prompts
- Less verbose by default than Pro
- Better at following concise structural cues
- May need explicit instruction for complex multi-step reasoning
- Cost-effective for high-volume tool calling

### Gemini 3 Pro

- **Optimized for**: Deepest multimodal reasoning, highest accuracy
- **Context window**: Up to 1M tokens input, 64k output
- **Pricing**: ~$2/1M input tokens, ~$12/1M output tokens
- **GPQA Diamond**: 91.9% (93.8% with Deep Think)
- **Terminal-Bench 2.0**: 54.2% on agentic tasks
- **Supports**: Deep Think advanced reasoning modes
- **Best for**: PhD-level scientific Q&A, complex agentic workflows, terminal automation, code debugging

**Prompting differences for Pro:**
- Handles longer, more complex system prompts well
- Better at maintaining constraints across long conversations
- Superior at multi-step reasoning without explicit chain-of-thought scaffolding
- More reliable for complex tool chaining / compositional function calling
- Can process larger context blocks without degradation

### Key Insight

Both models share the same core architecture but differ in inference optimization. The prompting fundamentals (temperature 1.0, structural consistency, few-shot examples) apply equally. The main difference is that Flash benefits from more concise instructions and simpler task decomposition, while Pro can handle more complex prompts without degradation.

---

## 10. Gemini 3 Specific Behavioral Notes

### Constraint Handling

> "Avoid overly broad negative instructions. Instead of 'do not infer,' use precise language: 'You are expected to perform calculations and logical deductions based strictly on the provided text. Do not introduce external information.'"

### Information Synthesis

Place specific questions AFTER large datasets. Anchor reasoning with phrases like:

> "Based on the entire document above, provide a comprehensive answer. Synthesize all relevant information."

### Reasoning Enhancement

For hard tasks, trigger explicit planning and self-critique:
```
Before answering:
1. Break the goal into sub-tasks
2. Outline a plan
3. Self-review against constraints
```

Google notes that Gemini 3's native reasoning capabilities mean you no longer need extensive chain-of-thought scaffolding. For routine tasks, the model reasons natively. Reserve explicit planning/self-critique instructions for genuinely complex tasks.

### Safety and Fallbacks

- Models return fallback text when prompts trigger safety filters.
- Recovery strategy: "If the model responds with a fallback response, try increasing the temperature." (Though for Gemini 3, keep at 1.0.)

---

## 11. Key Differences from Other Provider Conventions

### vs. Anthropic/Claude
- Gemini prefers XML tags or Markdown for structure; Claude uses XML tags heavily.
- Gemini 3 is concise by default; Claude tends toward verbose.
- Gemini strongly discourages changing temperature from 1.0; Claude is more flexible.
- Gemini has a 10-20 tool limit recommendation; Claude handles larger tool sets.

### vs. OpenAI/GPT
- Gemini uses `response_mime_type` for JSON mode; OpenAI uses `response_format`.
- Gemini function calling modes (AUTO/ANY/NONE) map roughly to OpenAI's `tool_choice`.
- Gemini's compositional function calling is more explicit about multi-turn chaining.

---

## 12. Actionable Recommendations for Our System Prompts

Based on this research, the Gemini model-specific addenda should include:

1. **Temperature reminder**: Explicitly state that temperature should remain at 1.0.
2. **Structural formatting**: Note that the prompt uses Markdown sections (consistent with Google's recommendations).
3. **Conciseness alignment**: The base prompt already emphasizes conciseness, which aligns perfectly with Gemini 3's default behavior.
4. **Tool use optimization**: Add guidance about clear function descriptions and the 10-20 active tool recommendation.
5. **Constraint placement**: Note that negative constraints should appear at the end of instruction blocks.
6. **Reasoning triggers**: For complex tasks, include the plan/self-review pattern.
7. **Few-shot encouragement**: When applicable, include examples in task instructions.
8. **Grounding patterns**: For context-dependent tasks, use the grounding declaration pattern.
9. **Flash-specific**: Shorter prompts, simpler task decomposition, faster iteration.
10. **Pro-specific**: Complex reasoning chains, larger context handling, multi-step tool chaining.

---

## Sources

- https://ai.google.dev/gemini-api/docs/prompting-strategies
- https://ai.google.dev/gemini-api/docs/function-calling
- https://ai.google.dev/gemini-api/docs/structured-output
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/prompt-design-strategies
- https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-structured-outputs/
- https://deepwiki.com/google-gemini/cookbook/4.1-function-calling-and-tool-use
- https://cloud.google.com/vertex-ai/generative-ai/docs/models/tune-function-calling
- https://www.cometapi.com/en/gemini-3-flash-vs-gemini-3-pro/
- https://promptbuilder.cc/blog/gemini-3-prompting-playbook-november-2025/
