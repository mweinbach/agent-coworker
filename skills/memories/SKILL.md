---
name: memories
description: Use when the user asks to view, list, inspect, add, create, edit, correct, update, or manage long-term memories for the current chat or workspace.
---

# Memories

Use this skill for explicit memory-management requests. The goal is to keep long-term memory accurate without touching unrelated folders or inventing duplicate entries.

## Workflow

1. Start with `manageMemory` action `list` to see the active folder, readable folders, paths, and summaries.
2. Use `manageMemory` action `read` before changing an existing memory.
3. Prefer `edit` when a relevant memory already exists. Use `create` only for a genuinely new durable fact, preference, or project note.
4. Keep memory bodies concise and factual. Do not store secrets, credentials, transient status, or speculative conclusions.
5. Use memory types consistently: `feedback` for user preferences or corrections, `project` for workspace-specific implementation context, and `note` for durable general context.
6. After any unavoidable manual memory file repair, run `manageMemory` action `refresh_index`.

## Boundaries

- Use `manageMemory` for list/read/create/edit/refresh. Do not hand-write Markdown memory files when the tool is available.
- Writes always go to the active memory folder for this chat or workspace.
- `(chats)` may appear as shared readable context from project workspaces, but do not try to write to it unless it is the active folder.
- Do not delete memories from this skill. Use the app or admin memory controls for deletion.
- If `manageMemory` is unavailable, advanced memory may be disabled. Use the legacy `memory` tool only when it is present.
