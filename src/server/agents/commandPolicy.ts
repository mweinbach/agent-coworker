/**
 * Shell mutation policy tag for agent roles.
 *
 * NOTE: The OS-level sandbox (`src/platform/sandbox`) is now the real
 * enforcement boundary for shell command writes and path scope. The previous
 * parse-based command filtering (`getShellCommandPolicyViolation` /
 * `getShellCommandPathScopeViolation`) was bypassable and has been removed in
 * favor of that sandbox. This type is retained only as the role/runtime plumbing
 * hint (read-only roles resolve to a no-project-write `SandboxPolicy`); see
 * `src/server/agents/roles.ts` and `src/agent.ts`.
 */
export type AgentShellPolicy = "full" | "no_project_write";
