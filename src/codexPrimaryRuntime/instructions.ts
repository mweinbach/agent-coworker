function envValue(env: Record<string, string | undefined> | undefined, key: string): string {
  if (!env) return "";
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? (env[actualKey] ?? "") : "";
}

export function renderCodexPrimaryRuntimeInstructions(
  env: Record<string, string | undefined> | undefined,
): string | null {
  const nodeModulesPath = envValue(env, "COWORK_CODEX_RUNTIME_NODE_MODULES");
  if (!nodeModulesPath) return null;

  const nodePath = envValue(env, "COWORK_CODEX_RUNTIME_NODE");
  const pythonPath = envValue(env, "COWORK_CODEX_RUNTIME_PYTHON");
  const resolverPath = envValue(env, "COWORK_CODEX_RUNTIME_NODE_RESOLVER");
  const linkExample =
    process.platform === "win32"
      ? `cmd /c mklink /J node_modules "%COWORK_CODEX_RUNTIME_NODE_MODULES%"`
      : `ln -s "$COWORK_CODEX_RUNTIME_NODE_MODULES" node_modules`;
  const nodeExample =
    process.platform === "win32"
      ? `& "$env:COWORK_CODEX_RUNTIME_NODE" .\\builder.mjs`
      : `"${nodePath || "$COWORK_CODEX_RUNTIME_NODE"}" ./builder.mjs`;

  return [
    "## Codex Workspace Dependencies",
    "",
    resolverPath
      ? "Cowork-managed Codex workspace dependencies are already wired into Node module resolution for this turn."
      : `Cowork-managed Codex workspace dependencies are available through \`COWORK_CODEX_RUNTIME_NODE_MODULES\`.`,
    ...(nodePath ? [`Use bundled Node at \`${nodePath}\` for artifact builders.`] : []),
    ...(pythonPath
      ? [`Use bundled Python at \`${pythonPath}\` when a skill requires Python.`]
      : []),
    resolverPath
      ? 'For spreadsheet, document, and presentation artifact work, run builders from a writable scratch work directory; bare imports such as `import "@oai/artifact-tool"` should resolve directly.'
      : "For spreadsheet, document, and presentation artifact work, run builders from a scratch work directory and link that directory's `node_modules` to the managed dependency directory before importing packages.",
    ...(resolverPath ? [] : [`Example link setup from the scratch directory: \`${linkExample}\`.`]),
    ...(nodePath ? [`Example builder run: \`${nodeExample}\`.`] : []),
    resolverPath
      ? "Do not link, install, copy, or search for `@oai/artifact-tool`; if the direct import fails, report a setup blocker with the Codex dependency env keys."
      : '`NODE_PATH` alone is not enough for ESM imports such as `import "@oai/artifact-tool"`; create the local `node_modules` link first.',
    ...(resolverPath
      ? []
      : [
          "Do not install, copy, or search for `@oai/artifact-tool` in guessed locations. If this dependency path exists, use it as the source of truth.",
        ]),
  ].join("\n");
}
