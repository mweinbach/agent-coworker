# Model Selection for Workflows & Subagents

## Default choice

Prefer **GPT-6 Astra (`gpt-6-astra`)**, when the selected coding harness exposes it, for substantial software engineering, research, computer use, and professional work. Follow [astra.md](astra.md) for prompting and API constraints.

An explicit user model choice takes precedence. For routine bounded work, use an available lower-cost model when it meets the quality requirement. Judge actual results; do not infer capability from version ordering or assume any model is free. Compare cost per completed task rather than token prices alone.

The earlier project preferences for **sonnet-5**, **opus-4.8**, and **fable-5** remain alternatives when exposed by the harness. Use a capable independent reviewer when a task needs fresh judgment. UI, copy, and API design require attention to taste as well as correctness; no local Astra quality or cost score is asserted here.

## Availability and delegation

- Check the active harness's model catalog and tool schema. A model documented by a vendor is not necessarily exposed by the current agent, subscription, provider adapter, or workflow tool.
- Use a model override only when the tool supports it. Otherwise inherit the current/default model. Do not invent an override or claim a child used Astra when its model cannot be selected or verified.
- For Codex, use the installed CLI's supported model-selection mechanism if it exposes Astra. Do not assume `~/.codex/config.toml` selects a particular model, or modify authentication/configuration merely to satisfy this guide.
- Avoid wrapper agents whose only job is to launch another agent unless that is the available, authorized route and the work warrants its overhead.
- Delegate independent work with bounded scope and readable handoffs. Do not repeat a child's investigation or assign overlapping edits. Continue directly when delegation is unavailable; do not repeatedly launch a failing route.
- Never use Haiku.

## Runtime constraints

Cowork's supported-model registry is a separate concern from the model editing this repository. Models offered by the product must be registered explicitly in `config/models/`; see [adding-models.md](adding-models.md). Native Astra API capabilities require compatible provider/runtime implementations.

For Astra API requests, use Responses for tools. Migrate `none`/`minimal` reasoning to `low`; otherwise preserve effective effort. Follow the complete parameter and caching requirements in [astra.md](astra.md) rather than copying settings from GPT-5.5.

Auth boundaries remain in [repo-contracts.md](repo-contracts.md). Do not copy credentials between a coding agent's auth home and Cowork's managed runtime.
