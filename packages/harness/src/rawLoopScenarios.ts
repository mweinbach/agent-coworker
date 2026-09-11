import { z } from "zod";

import { hostPlatform } from "../../../src/platform/host";
import { commands } from "../../../src/platform/shell";
import type { HarnessContextPayload, ProviderName } from "../../../src/types";
import { buildPathArtifactAssertions, type FinalContract } from "./rawLoopValidation";

/**
 * Scenario definitions for the raw-loop harness.
 *
 * A scenario is a named list of `RunSpec`s. Each run is a scripted prompt that
 * asks a live model to use specific tools and finish with a JSON contract, so a
 * scenario doubles as a tool-coverage and instruction-following measurement.
 *
 * Model ids must be registry ids from `config/models/<provider>/`; the runner
 * passes them straight to the provider, so an unregistered id silently loses
 * the model's prompt template and provider-option defaults.
 */

export type PromptContext = {
  runId: string;
  runDir: string;
  repoDir: string;
};

export type RunSpec = {
  id: string;
  provider: ProviderName;
  model: string;
  maxSteps?: number;
  maxAttempts?: number;
  requiredToolCalls?: string[];
  requiredToolBeforeTools?: string;
  guardedToolsBeforeRequiredTool?: string[];
  harnessContext?: (ctx: PromptContext) => HarnessContextPayload;
  finalContract?: FinalContract;
  prompt: (ctx: PromptContext) => string;
};

const absolutePathSchema = z.string().trim().min(1);
const endSentinelSchema = z.literal("<<END_RUN>>");

/** Builds the JSON final-response contract every run must satisfy. */
function jsonFileContract(
  fields: Record<string, z.ZodTypeAny>,
  artifacts: Record<string, string> = {},
): FinalContract {
  return {
    format: "json",
    schema: z.object({ ...fields, end: endSentinelSchema }).strict(),
    artifactAssertions: Object.entries(artifacts).flatMap(([field, ext]) =>
      buildPathArtifactAssertions(field, ext),
    ),
  };
}

/**
 * Renders the shared run-prompt skeleton. Steps are written without numbers and
 * numbered here so the ordering the runner enforces stays obvious in source.
 */
function renderRunPrompt(opts: {
  runDir: string;
  task: string;
  steps: string[];
  finalJson: string;
}): string {
  const steps = opts.steps.map((step, index) => `${index + 1}) ${step}`).join("\n");
  return `You are running inside workingDirectory="${opts.runDir}". Keep ALL created files inside this working directory.

Task: ${opts.task}

Steps (must use tools):
${steps}

Final response must be a raw JSON object:
${opts.finalJson}`;
}

export function buildMixedRuns(platform: NodeJS.Platform = hostPlatform()): RunSpec[] {
  const shell = commands(platform);

  return [
    {
      id: "run-01",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 60,
      finalContract: jsonFileContract(
        {
          run_id: z.string().trim().min(1),
          memo_file: absolutePathSchema,
          tool_summary: z.string().trim().min(1),
        },
        { memo_file: ".md" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: `Research HTTP 418 ("I'm a teapot") and RFC 2324, then write a short memo.`,
          steps: [
            "Call todoWrite with a 4-item plan; set exactly one item to in_progress.",
            `Use webSearch with query "HTTP 418 I'm a teapot RFC 2324" and maxResults=5.`,
            "Pick the single most authoritative URL from the results and use webFetch on it (maxLength=8000).",
            `Use write to create "memo.md" containing:
- A title
- 3 bullet points with citations (URL inline)
- 1 short paragraph on why 418 appears in real systems`,
            `Use glob to confirm "memo.md" exists (pattern: "memo.md").`,
            `Use read to read back "memo.md" (limit=200, offset=1).`,
            "Update todoWrite marking all items completed.",
          ],
          finalJson: `{ "run_id": "...", "memo_file": "<absolute path>", "tool_summary": "<one sentence>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-02",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 80,
      finalContract: jsonFileContract(
        { bash_tool_notes: absolutePathSchema },
        {
          bash_tool_notes: ".md",
        },
      ),
      prompt: ({ runDir, repoDir }) =>
        renderRunPrompt({
          runDir,
          task: "Produce an internal note explaining how command approvals and the bash tool work in this repo.",
          steps: [
            `Use bash to run: ${shell.printWorkingDirectory()}`,
            `Use grep to search for pattern "approveCommand" in path "${repoDir}/src" (caseSensitive=true).`,
            `Use read to read "${repoDir}/src/tools/bash.ts" (limit=200, offset=1).`,
            `Use read to read "${repoDir}/src/utils/approval.ts" (limit=240, offset=1).`,
            `Use write to create "bash_tool_notes.md" with:
- A short overview
- A table listing: approval hook, working directory behavior, timeout defaults, stdout/stderr truncation
- A "Gotchas" section`,
            `Use edit to replace the exact string "TODO_REPLACE_ME" in "bash_tool_notes.md" with a concrete gotcha you found.`,
            `Use bash to run: ${shell.listDirectory()}`,
          ],
          finalJson: `{ "bash_tool_notes": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-03",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxSteps: 90,
      finalContract: jsonFileContract(
        { xlsx: absolutePathSchema, verify: absolutePathSchema },
        { xlsx: ".xlsx", verify: ".txt" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Build a real Excel amortization model (XLSX) for a loan and save verification output.",
          steps: [
            `Use skill to load skillName="spreadsheet".`,
            `Use write to create "build_amortization.py" that generates "amortization.xlsx" with:
- Sheet "Inputs" (Principal=25000, APR=6%, TermMonths=36) with clear labels
- Sheet "Schedule" with columns: Period, Payment, Interest, Principal, Balance
- Use Excel formulas (do not hardcode results); payment should reference Inputs
- Basic formatting (currency/percent) and frozen header row
- Add a Source note in the sheet (plain URL) for the PMT formula reference (any authoritative URL)
Also have the script write "verify.txt" with:
- workbook sheet names
- first 5 schedule lines (values or formulas)`,
            `Use bash to run: ${shell.runPythonScript("build_amortization.py")}`,
            `Use glob to confirm both files exist: "amortization.xlsx" and "verify.txt".`,
            `Use read to read back "verify.txt" (limit=200, offset=1).`,
          ],
          finalJson: `{ "xlsx": "<absolute path>", "verify": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-04",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 90,
      finalContract: jsonFileContract(
        { docx: absolutePathSchema, excerpt: absolutePathSchema },
        { docx: ".docx", excerpt: ".txt" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Create a professional DOCX brief and a text extract for quick inspection.",
          steps: [
            `Use skill to load skillName="doc".`,
            `Use write to create "build_brief_docx.py" that generates "brief.docx" with:
- Title
- 2 headings
- A bulleted list
- A 2x3 table
The script must also extract plain text from the DOCX into "brief_excerpt.txt".`,
            `Use bash to run: ${shell.runPythonScript("build_brief_docx.py")}`,
            `Use glob to confirm "brief.docx" and "brief_excerpt.txt" exist.`,
            `Use read to read back "brief_excerpt.txt" (limit=200, offset=1).`,
          ],
          finalJson: `{ "docx": "<absolute path>", "excerpt": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-05",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 110,
      finalContract: jsonFileContract(
        { deck: absolutePathSchema, outline: absolutePathSchema },
        { deck: ".pptx", outline: ".txt" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Create a PPTX deck and a machine-readable outline of its slides.",
          steps: [
            `Use skill to load skillName="slides".`,
            `Use write to create "build_deck.py" that generates "deck.pptx" with 5 slides:
- Slide 1: title slide
- Slide 2: agenda bullets
- Slide 3: a table
- Slide 4: a simple bar chart (if charting is too hard, include a labeled bar chart as shapes)
- Slide 5: conclusion
Also have the script write "deck_outline.txt" with one line per slide: "<index> - <title>".`,
            `Use bash to run: ${shell.runPythonScript("build_deck.py")}`,
            `Use glob to confirm "deck.pptx" and "deck_outline.txt" exist.`,
            `Use read to read back "deck_outline.txt" (limit=50, offset=1).`,
          ],
          finalJson: `{ "deck": "<absolute path>", "outline": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-06",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxSteps: 110,
      finalContract: jsonFileContract(
        { pdf: absolutePathSchema, meta: absolutePathSchema },
        { pdf: ".pdf", meta: ".json" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Create a PDF report and write a small verification file describing it.",
          steps: [
            `Use skill to load skillName="pdf".`,
            `Use write to create "build_report_pdf.py" that generates "report.pdf" with:
- Title, date, and a short paragraph
- A small table (at least 4 rows)
Also have the script write "report_meta.json" with:
- page_count
- sha256 of the PDF`,
            `Use bash to run: ${shell.runPythonScript("build_report_pdf.py")}`,
            `Use glob to confirm "report.pdf" and "report_meta.json" exist.`,
            `Use read to read back "report_meta.json" (limit=80, offset=1).`,
          ],
          finalJson: `{ "pdf": "<absolute path>", "meta": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-07",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 90,
      finalContract: jsonFileContract({ dataset: z.string().trim().min(1) }),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Exercise AskUserQuestion + edit + memory in one run.",
          steps: [
            `Use AskUserQuestion with question "Pick a dataset name" and options ["alpha","beta","gamma","delta"].`,
            `Use write to create "notes.txt" with a single line: dataset: PLACEHOLDER`,
            `Use edit to replace "PLACEHOLDER" in "notes.txt" with the selected dataset name.`,
            `Use memory with action="write", key="runs/run07", content="dataset=<dataset>".`,
            `Use memory with action="read", key="runs/run07".`,
            `Use memory with action="search", query="dataset=".`,
            `Use read to read back "notes.txt" (limit=200, offset=1).`,
          ],
          finalJson: `{ "dataset": "<dataset>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-08",
      provider: "openai",
      model: "gpt-5-mini",
      maxSteps: 120,
      requiredToolCalls: [
        "spawnAgent",
        "waitForAgent",
        "webFetch",
        "write",
        "edit",
        "glob",
        "read",
      ],
      finalContract: jsonFileContract({ report: absolutePathSchema }, { report: ".md" }),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Use a research sub-agent, then write and lightly edit a short report.",
          steps: [
            `Use spawnAgent with role="research" and message:
"Find the latest stable Bun release version (as of today) and one authoritative URL. Return JSON only: {\\"version\\":\\"...\\",\\"url\\":\\"...\\"}."`,
            `Use waitForAgent with the returned agentId and timeoutMs=10000. Check erroredAgentIds first — if the agentId is listed there, treat it as failed and do not use its text. Only when it is absent from erroredAgentIds, extract version and URL from the completed agent's lastMessagePreview JSON.`,
            `Use webFetch on the returned URL (maxLength=6000).`,
            `Use write to create "bun_release_report.md" with:
- version and URL
- 3 bullet summary
- A short 'Limitations' section`,
            `Use edit to replace the exact string "LIMITATIONS_TODO" with a concrete limitation.`,
            `Use glob with pattern "*.md".`,
            `Use read to read back "bun_release_report.md" (limit=220, offset=1).`,
          ],
          finalJson: `{ "report": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-09",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxSteps: 90,
      finalContract: jsonFileContract({ ws_quickref: absolutePathSchema }, { ws_quickref: ".md" }),
      prompt: ({ runDir, repoDir }) =>
        renderRunPrompt({
          runDir,
          task: "Create a WebSocket protocol quick reference based on the repo docs.",
          steps: [
            `Use read to read "${repoDir}/docs/websocket-protocol.md" (limit=260, offset=1).`,
            `Use grep to find lines matching pattern "type: \\"(client_|server_)" in path "${repoDir}/docs/websocket-protocol.md".`,
            `Use write to create "ws_quickref.md" that includes:
- A short introduction
- A table of message/event types you found (name + one-sentence meaning)`,
            `Use bash to run: ${shell.countLines("ws_quickref.md")}`,
          ],
          finalJson: `{ "ws_quickref": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-10",
      provider: "google",
      model: "gemini-3-flash-preview",
      maxSteps: 140,
      finalContract: jsonFileContract({ manifest: absolutePathSchema }, { manifest: ".json" }),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Create a small bundle of artifacts: XLSX + DOCX + PPTX derived from one tiny dataset.",
          steps: [
            `Use skill to load skillName="spreadsheet".`,
            `Use skill to load skillName="doc".`,
            `Use skill to load skillName="slides".`,
            `Use write to create "build_bundle.py" that:
- Creates "dataset.csv" with 12 rows: month, revenue, cost
- Creates "bundle.xlsx" that imports the dataset into a sheet and computes gross profit and margin with formulas
- Creates "bundle.docx" that contains a short narrative summary and a table of the dataset
- Creates "bundle.pptx" with 4 slides: title, key metrics, table, conclusion
- Writes "bundle_manifest.json" listing filenames and sha256 hashes`,
            `Use bash to run: ${shell.runPythonScript("build_bundle.py")}`,
            `Use glob with pattern "bundle_*.*".`,
            `Use read to read back "bundle_manifest.json" (limit=200, offset=1).`,
          ],
          finalJson: `{ "manifest": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
    {
      id: "run-11",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxSteps: 40,
      maxAttempts: 2,
      requiredToolCalls: ["todoWrite", "webSearch", "write", "read"],
      requiredToolBeforeTools: "webSearch",
      guardedToolsBeforeRequiredTool: ["write", "read"],
      finalContract: jsonFileContract(
        { run_id: z.string().trim().min(1), memo: absolutePathSchema },
        { memo: ".md" },
      ),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Demonstrate Claude Sonnet tool use with web research.",
          steps: [
            "Use todoWrite to create 3 items and mark exactly one in_progress.",
            `Use webSearch for query "HTTP 418 RFC 2324" with maxResults=4.`,
            `Use write to create "sonnet_web_research.md" containing: title + 3 bullets from search results with URL citations.`,
            `Use read to read "sonnet_web_research.md" (limit=200, offset=1).`,
            "Use todoWrite to mark all items completed.",
          ],
          finalJson: `{ "run_id": "run-11", "memo": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
  ];
}

export function buildCodexHarnessSmokeRuns(platform: NodeJS.Platform = hostPlatform()): RunSpec[] {
  const shell = commands(platform);

  return [
    {
      id: "codex-smoke-01-core-tools",
      provider: "codex-cli",
      model: "gpt-5.4",
      maxSteps: 90,
      maxAttempts: 3,
      requiredToolCalls: ["todoWrite", "bash", "grep", "read", "write", "glob"],
      finalContract: jsonFileContract({ report: absolutePathSchema }, { report: ".md" }),
      prompt: ({ runDir }) =>
        renderRunPrompt({
          runDir,
          task: "Smoke-test the harness against the current repo using a focused local tool loop.",
          steps: [
            "Use todoWrite to create 4 items and set exactly one item to in_progress.",
            `Use bash to run: ${shell.printWorkingDirectory()}`,
            `Use write to create "harness_source.txt" containing at least 3 lines, and one line must include the exact text "runTurnWithDeps".`,
            `Use grep with pattern "runTurnWithDeps" in path "harness_source.txt".`,
            `Use read to read "harness_source.txt" (limit=120, offset=1).`,
            `Use write to create "codex_harness_smoke.md" with:
- A title
- A short paragraph explaining what the harness run validated
- 3 bullets summarizing what you observed from the repo/tooling`,
            `Use glob with pattern "codex_harness_smoke.md".`,
            `Use read to read "codex_harness_smoke.md" (limit=220, offset=1).`,
            "Use todoWrite to mark all items completed.",
          ],
          finalJson: `{ "report": "<absolute path>", "end": "<<END_RUN>>" }`,
        }),
    },
  ];
}

export const SCENARIO_DEFINITIONS = {
  mixed: { runRootPrefix: "raw-agent-loop_mixed", build: () => buildMixedRuns() },
  "codex-gpt-5.4-smoke": {
    runRootPrefix: "raw-agent-loop_codex-gpt-5.4-smoke",
    build: () => buildCodexHarnessSmokeRuns(),
  },
} as const;

export type Scenario = keyof typeof SCENARIO_DEFINITIONS;

export function isScenario(value: string): value is Scenario {
  return Object.hasOwn(SCENARIO_DEFINITIONS, value);
}

export function selectRawLoopRuns(selection: {
  scenario: Scenario;
  onlyRunIds: string[];
  onlyModels: string[];
}): RunSpec[] {
  const runs = SCENARIO_DEFINITIONS[selection.scenario].build().filter((run) => {
    if (selection.onlyRunIds.length > 0 && !selection.onlyRunIds.includes(run.id)) {
      return false;
    }
    if (selection.onlyModels.length > 0 && !selection.onlyModels.includes(run.model)) {
      return false;
    }
    return true;
  });

  if (runs.length === 0) {
    throw new Error(
      `No runs selected for scenario="${selection.scenario}". Try --only-run/--only-model values that exist in this scenario.`,
    );
  }
  return runs;
}
