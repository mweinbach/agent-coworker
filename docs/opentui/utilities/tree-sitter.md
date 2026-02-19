# Tree-Sitter Integration

OpenTUI integrates tree-sitter for fast, incremental, worker-based syntax highlighting. The tree-sitter subsystem runs parsing in a background worker thread and emits highlight data as events, keeping the main rendering thread responsive. It supports multiple languages, language injection (e.g., JavaScript inside Markdown), and incremental buffer updates for streaming content.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
- [TreeSitterClient](#treesitterclient)
  - [TreeSitterClientOptions](#treesitterclientoptions)
  - [Constructor and Initialization](#constructor-and-initialization)
  - [One-Shot Highlighting](#one-shot-highlighting)
  - [Buffer Management](#buffer-management)
  - [Parser Management](#parser-management)
  - [Lifecycle and Cache](#lifecycle-and-cache)
  - [Performance Monitoring](#performance-monitoring)
  - [Events](#events)
- [Types](#types)
  - [SimpleHighlight](#simplehighlight)
  - [HighlightRange](#highlightrange)
  - [HighlightResponse](#highlightresponse)
  - [HighlightMeta](#highlightmeta)
  - [Edit](#edit)
  - [BufferState](#bufferstate)
  - [ParsedBuffer](#parsedbuffer)
  - [FiletypeParserOptions](#filetypeparseroptions)
  - [InjectionMapping](#injectionmapping)
  - [PerformanceStats](#performancestats)
- [Parser Worker](#parser-worker)
- [Filetype Resolution](#filetype-resolution)
  - [extToFiletype()](#exttofiletype)
  - [pathToFiletype()](#pathtofiletype)
- [Default Parsers](#default-parsers)
  - [getParsers()](#getparsers)
  - [addDefaultParsers()](#adddefaultparsers)
  - [Parser Configuration Format](#parser-configuration-format)
- [Download Utilities](#download-utilities)
  - [DownloadResult](#downloadresult)
  - [DownloadUtils Class](#downloadutils-class)
- [Styled Text Conversion](#styled-text-conversion)
  - [treeSitterToTextChunks()](#treesittertotextchunks)
  - [treeSitterToStyledText()](#treesittertostyledtext)
- [Asset Management](#asset-management)
  - [updateAssets()](#updateassets)
  - [UpdateOptions](#updateoptions)
- [Singleton Access](#singleton-access)
  - [getTreeSitterClient()](#gettreesitterclient)
- [Usage Patterns](#usage-patterns)
  - [Basic Highlighting](#basic-highlighting)
  - [Buffer-Based Incremental Highlighting](#buffer-based-incremental-highlighting)
  - [Streaming / LLM Integration](#streaming--llm-integration)
  - [Adding a Custom Language](#adding-a-custom-language)
  - [Using with Code Component](#using-with-code-component)
- [Supported Languages](#supported-languages)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Main Thread                                            │
│                                                         │
│  TreeSitterClient                                       │
│  ├── createBuffer() / updateBuffer() / highlightOnce()  │
│  ├── emits "highlights:response" events                 │
│  └── manages BufferState map                            │
│           │                                             │
│           │  postMessage / onMessage                     │
│           ▼                                             │
│  ┌─────────────────────────┐                            │
│  │  Worker Thread           │                           │
│  │  parser.worker           │                           │
│  │  ├── loads .wasm parsers │                           │
│  │  ├── incremental parsing │                           │
│  │  └── query execution     │                           │
│  └─────────────────────────┘                            │
└─────────────────────────────────────────────────────────┘
```

The client sends content and edits to the worker thread. The worker loads tree-sitter WASM grammars, maintains parse trees, and runs highlight queries. Results flow back as events to the main thread, where they can be applied to renderables like `CodeRenderable`.

---

## Getting Started

```typescript
import { TreeSitterClient } from "@opentui/core/lib/tree-sitter"

const client = new TreeSitterClient({
  dataPath: "./tree-sitter-data",
})
await client.initialize()

// One-shot highlight
const result = await client.highlightOnce(
  'const greeting = "hello"',
  "typescript"
)
console.log(result.highlights)
// [[0, 5, "keyword"], [6, 14, "variable"], ...]

// Clean up
await client.destroy()
```

---

## TreeSitterClient

The main class for all tree-sitter operations. Extends `EventEmitter` with typed events.

```typescript
class TreeSitterClient extends EventEmitter<TreeSitterClientEvents> {
  constructor(options: TreeSitterClientOptions)

  // Initialization
  initialize(): Promise<void>
  isInitialized(): boolean

  // One-shot highlighting
  highlightOnce(content: string, filetype: string): Promise<{
    highlights?: SimpleHighlight[]
    warning?: string
    error?: string
  }>

  // Buffer management
  createBuffer(id: number, content: string, filetype: string, version?: number, autoInitialize?: boolean): Promise<boolean>
  updateBuffer(id: number, edits: Edit[], newContent: string, version: number): Promise<void>
  removeBuffer(bufferId: number): Promise<void>
  resetBuffer(bufferId: number, version: number, content: string): Promise<void>
  getBuffer(bufferId: number): BufferState | undefined
  getAllBuffers(): BufferState[]

  // Parser management
  addFiletypeParser(filetypeParser: FiletypeParserOptions): void
  preloadParser(filetype: string): Promise<boolean>

  // Configuration
  setDataPath(dataPath: string): Promise<void>
  clearCache(): Promise<void>

  // Performance
  getPerformance(): Promise<PerformanceStats>

  // Lifecycle
  destroy(): Promise<void>
}
```

### TreeSitterClientOptions

```typescript
interface TreeSitterClientOptions {
  dataPath: string
  workerPath?: string | URL
  initTimeout?: number
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `dataPath` | `string` | *required* | Directory for grammar WASM files and cached query files. |
| `workerPath` | `string \| URL` | `OTUI_TREE_SITTER_WORKER_PATH` global | Path to the parser worker script. Falls back to the global constant set at build time. |
| `initTimeout` | `number` | `30000` | Timeout in milliseconds for worker initialization. |

A global constant `OTUI_TREE_SITTER_WORKER_PATH` is expected to be defined at build time (e.g., via a bundler define plugin) pointing to the parser worker entry.

### Constructor and Initialization

```typescript
const client = new TreeSitterClient({
  dataPath: "./tree-sitter-data",
  workerPath: "./parser.worker.js",
  initTimeout: 15000,
})

await client.initialize()
// Client is now ready. Default parsers are registered.

client.isInitialized() // true
```

`initialize()` starts the background worker, waits for it to be ready, and registers all default parsers. It is safe to call multiple times -- subsequent calls return the same promise.

### One-Shot Highlighting

```typescript
highlightOnce(content: string, filetype: string): Promise<{
  highlights?: SimpleHighlight[]
  warning?: string
  error?: string
}>
```

Highlights a string of content without creating a persistent buffer. Useful for static or small content that does not need incremental updates.

```typescript
const result = await client.highlightOnce(
  'function hello() { return "world" }',
  "typescript"
)

if (result.error) {
  console.error(result.error)
} else if (result.highlights) {
  for (const [start, end, group] of result.highlights) {
    console.log(`${group}: cols ${start}-${end}`)
  }
}
```

### Buffer Management

Buffers are persistent, incrementally-updated documents tracked by the worker. Use them for editor-like scenarios where content changes frequently.

#### createBuffer()

```typescript
createBuffer(
  id: number,
  content: string,
  filetype: string,
  version?: number,
  autoInitialize?: boolean
): Promise<boolean>
```

Creates a new buffer. Returns `true` if a parser exists for the filetype.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | `number` | *required* | Unique buffer identifier. |
| `content` | `string` | *required* | Initial content. |
| `filetype` | `string` | *required* | Language filetype (e.g., `"typescript"`, `"python"`). |
| `version` | `number` | `0` | Initial version number. |
| `autoInitialize` | `boolean` | `true` | Auto-initialize the client if not yet initialized. |

#### updateBuffer()

```typescript
updateBuffer(
  id: number,
  edits: Edit[],
  newContent: string,
  version: number
): Promise<void>
```

Apply incremental edits to a buffer. The `edits` array describes the structural changes (for tree-sitter's incremental parsing), and `newContent` is the full new content. The `version` must be strictly increasing.

#### removeBuffer()

```typescript
removeBuffer(bufferId: number): Promise<void>
```

Remove a buffer and free its resources in the worker.

#### resetBuffer()

```typescript
resetBuffer(bufferId: number, version: number, content: string): Promise<void>
```

Reset a buffer's content entirely (full reparse). Use when incremental edits are impractical (e.g., after a large external change).

#### getBuffer() / getAllBuffers()

```typescript
getBuffer(bufferId: number): BufferState | undefined
getAllBuffers(): BufferState[]
```

Query the local buffer state map. These reflect the client-side tracking; actual parse state lives in the worker.

### Parser Management

#### addFiletypeParser()

```typescript
addFiletypeParser(filetypeParser: FiletypeParserOptions): void
```

Register a new language parser at runtime. The parser definition includes the WASM grammar path, highlight queries, and optional injection configuration.

```typescript
client.addFiletypeParser({
  filetype: "rust",
  wasm: "https://example.com/tree-sitter-rust.wasm",
  queries: {
    highlights: [
      "https://example.com/highlights-rust.scm",
    ],
  },
})
```

#### preloadParser()

```typescript
preloadParser(filetype: string): Promise<boolean>
```

Eagerly load a parser's WASM binary and compile its queries. Returns `true` if the parser loaded successfully. Useful to avoid latency on first highlight.

### Lifecycle and Cache

#### destroy()

```typescript
destroy(): Promise<void>
```

Shut down the worker thread and clean up all resources. The client cannot be reused after destruction.

#### clearCache()

```typescript
clearCache(): Promise<void>
```

Clear the worker's internal caches (compiled queries, parsed trees).

#### setDataPath()

```typescript
setDataPath(dataPath: string): Promise<void>
```

Change the data directory at runtime. Affects where WASM and query files are resolved.

### Performance Monitoring

```typescript
getPerformance(): Promise<PerformanceStats>
```

Retrieve timing statistics from the worker.

```typescript
const stats = await client.getPerformance()
console.log(`Avg parse: ${stats.averageParseTime}ms`)
console.log(`Avg query: ${stats.averageQueryTime}ms`)
```

### Events

```typescript
interface TreeSitterClientEvents {
  "highlights:response": [bufferId: number, version: number, highlights: HighlightResponse[]]
  "buffer:initialized": [bufferId: number, hasParser: boolean]
  "buffer:disposed": [bufferId: number]
  "worker:log": [logType: "log" | "error", message: string]
  error: [error: string, bufferId?: number]
  warning: [warning: string, bufferId?: number]
}
```

| Event | Arguments | Description |
|-------|-----------|-------------|
| `highlights:response` | `(bufferId, version, highlights)` | New highlight data for a buffer. Fired after each successful parse + query cycle. |
| `buffer:initialized` | `(bufferId, hasParser)` | A buffer has been created and initialized. `hasParser` indicates whether a grammar was found. |
| `buffer:disposed` | `(bufferId)` | A buffer has been removed. |
| `worker:log` | `(logType, message)` | Log output from the worker thread. |
| `error` | `(error, bufferId?)` | An error occurred, optionally associated with a specific buffer. |
| `warning` | `(warning, bufferId?)` | A warning occurred, optionally associated with a specific buffer. |

```typescript
client.on("highlights:response", (bufferId, version, highlights) => {
  // Apply highlights to your code renderable
  console.log(`Buffer ${bufferId} v${version}: ${highlights.length} lines highlighted`)
})

client.on("error", (error, bufferId) => {
  console.error(`Tree-sitter error${bufferId ? ` (buffer ${bufferId})` : ""}: ${error}`)
})
```

---

## Types

All types are exported from `@opentui/core/lib/tree-sitter/types` and re-exported from the barrel module.

### SimpleHighlight

```typescript
type SimpleHighlight = [
  startCol: number,   // Start column (0-indexed, inclusive)
  endCol: number,     // End column (0-indexed, exclusive)
  group: string,      // Highlight group name (e.g., "keyword", "string", "function")
  meta?: HighlightMeta // Optional metadata for injections and concealment
]
```

A flat tuple representation of a single highlight span. This is the primary format used by `highlightOnce()` and the styled text conversion functions.

### HighlightRange

```typescript
interface HighlightRange {
  startCol: number
  endCol: number
  group: string
}
```

Object form of a highlight range within a single line.

### HighlightResponse

```typescript
interface HighlightResponse {
  line: number
  highlights: HighlightRange[]
  droppedHighlights: HighlightRange[]
}
```

Per-line highlight data emitted by the `highlights:response` event. `droppedHighlights` contains ranges that were computed but excluded (e.g., due to overlap resolution).

### HighlightMeta

```typescript
interface HighlightMeta {
  isInjection?: boolean
  injectionLang?: string
  containsInjection?: boolean
  conceal?: string | null
  concealLines?: string | null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `isInjection` | `boolean?` | Whether this highlight comes from an injected language. |
| `injectionLang` | `string?` | The language of the injection (e.g., `"javascript"` inside Markdown). |
| `containsInjection` | `boolean?` | Whether the highlighted region contains injected content. |
| `conceal` | `string \| null?` | Replacement text for concealment (e.g., rendering `->` as an arrow glyph). |
| `concealLines` | `string \| null?` | Line-level concealment replacement. |

### Edit

```typescript
interface Edit {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
  startPosition: { row: number; column: number }
  oldEndPosition: { row: number; column: number }
  newEndPosition: { row: number; column: number }
}
```

Describes an incremental edit for `updateBuffer()`. Matches tree-sitter's `TSInputEdit` format. Both byte indices and row/column positions are required for accurate incremental parsing.

### BufferState

```typescript
interface BufferState {
  id: number
  version: number
  content: string
  filetype: string
  hasParser: boolean
}
```

Client-side state for a tracked buffer.

### ParsedBuffer

```typescript
interface ParsedBuffer extends BufferState {
  hasParser: true
}
```

A `BufferState` that is guaranteed to have an associated parser.

### FiletypeParserOptions

```typescript
interface FiletypeParserOptions {
  filetype: string
  queries: {
    highlights: string[]
    injections?: string[]
  }
  wasm: string
  injectionMapping?: InjectionMapping
}
```

| Field | Type | Description |
|-------|------|-------------|
| `filetype` | `string` | Language identifier (e.g., `"typescript"`, `"python"`). |
| `queries.highlights` | `string[]` | Array of highlight query sources (URLs or file paths to `.scm` files). Multiple queries are concatenated. |
| `queries.injections` | `string[]?` | Array of injection query sources for embedded language support. |
| `wasm` | `string` | Path or URL to the tree-sitter WASM grammar file. |
| `injectionMapping` | `InjectionMapping?` | Configuration for how injected languages are resolved. |

### InjectionMapping

```typescript
interface InjectionMapping {
  nodeTypes?: { [nodeType: string]: string }
  infoStringMap?: { [infoString: string]: string }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `nodeTypes` | `Record<string, string>?` | Maps AST node types to language names (e.g., `{ "inline": "javascript" }`). |
| `infoStringMap` | `Record<string, string>?` | Maps code fence info strings to language names (e.g., `{ "js": "javascript", "ts": "typescript" }`). |

### PerformanceStats

```typescript
interface PerformanceStats {
  averageParseTime: number
  parseTimes: number[]
  averageQueryTime: number
  queryTimes: number[]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `averageParseTime` | `number` | Average time (ms) for parsing operations. |
| `parseTimes` | `number[]` | Raw parse time samples. |
| `averageQueryTime` | `number` | Average time (ms) for highlight query operations. |
| `queryTimes` | `number[]` | Raw query time samples. |

---

## Parser Worker

```typescript
// parser.worker.d.ts
export {}
```

The parser worker is an opaque worker script that runs in a background thread. It is referenced by path (via `workerPath` option or the `OTUI_TREE_SITTER_WORKER_PATH` global constant) and communicates with `TreeSitterClient` via structured message passing.

The worker handles:

- Loading and compiling tree-sitter WASM grammars
- Maintaining parse trees per buffer
- Executing highlight and injection queries
- Incremental re-parsing after edits
- Caching compiled parsers and queries

You do not interact with the worker directly. All communication is managed by `TreeSitterClient`.

---

## Filetype Resolution

Utility functions for mapping file extensions and paths to tree-sitter filetype identifiers.

### extToFiletype()

```typescript
function extToFiletype(extension: string): string | undefined
```

Maps a file extension (with or without leading dot) to a filetype string.

```typescript
import { extToFiletype } from "@opentui/core/lib/tree-sitter"

extToFiletype(".ts")    // "typescript"
extToFiletype("ts")     // "typescript"
extToFiletype(".py")    // "python"
extToFiletype(".rs")    // "rust"
extToFiletype(".xyz")   // undefined
```

### pathToFiletype()

```typescript
function pathToFiletype(path: string): string | undefined
```

Extracts the extension from a file path and resolves it to a filetype.

```typescript
import { pathToFiletype } from "@opentui/core/lib/tree-sitter"

pathToFiletype("src/main.ts")      // "typescript"
pathToFiletype("lib/server.py")    // "python"
pathToFiletype("Cargo.toml")       // "toml" (if supported)
pathToFiletype("README.md")        // "markdown"
pathToFiletype("Makefile")         // undefined (no extension)
```

---

## Default Parsers

OpenTUI ships with a set of pre-configured parsers for common languages.

### getParsers()

```typescript
function getParsers(): FiletypeParserOptions[]
```

Returns the array of built-in parser configurations. Each entry contains the filetype, WASM grammar path, and highlight query sources.

### addDefaultParsers()

```typescript
function addDefaultParsers(parsers: FiletypeParserOptions[]): void
```

Register additional parsers that will be included in the default set. These are applied when `TreeSitterClient.initialize()` is called. Call this before initialization to extend the built-in language support.

```typescript
import { addDefaultParsers, TreeSitterClient } from "@opentui/core/lib/tree-sitter"

addDefaultParsers([
  {
    filetype: "elixir",
    wasm: "./tree-sitter-elixir.wasm",
    queries: {
      highlights: ["./highlights-elixir.scm"],
    },
  },
])

const client = new TreeSitterClient({ dataPath: "./data" })
await client.initialize()
// Elixir parser is now available alongside built-in parsers
```

### Parser Configuration Format

The default parsers are defined in `parsers-config.ts` (source of truth) and compiled into `default-parsers.ts` via the asset update script. The configuration format matches `FiletypeParserOptions`:

```typescript
// Example from the default config
const config = {
  parsers: [
    {
      filetype: "typescript",
      wasm: "tree-sitter-typescript.wasm",
      queries: {
        highlights: ["highlights-typescript.scm"],
      },
    },
    {
      filetype: "markdown",
      wasm: "tree-sitter-markdown.wasm",
      queries: {
        highlights: ["highlights-markdown.scm"],
        injections: ["injections-markdown.scm"],
      },
      injectionMapping: {
        nodeTypes: {
          inline: "markdown_inline",
          pipe_table_cell: "markdown_inline",
        },
        infoStringMap: {
          javascript: "javascript",
          js: "javascript",
          typescript: "typescript",
          ts: "typescript",
          markdown: "markdown",
          md: "markdown",
        },
      },
    },
  ],
}
```

---

## Download Utilities

The `DownloadUtils` class handles fetching WASM grammars and `.scm` query files from remote or local sources, with caching support.

### DownloadResult

```typescript
interface DownloadResult {
  content?: ArrayBuffer
  filePath?: string
  error?: string
}
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | `ArrayBuffer?` | The downloaded file contents (for in-memory use). |
| `filePath` | `string?` | Path to the cached file on disk. |
| `error` | `string?` | Error message if the download failed. |

### DownloadUtils Class

```typescript
class DownloadUtils {
  /** Download a file from URL or load from local path, with caching. */
  static downloadOrLoad(
    source: string,
    cacheDir: string,
    cacheSubdir: string,
    fileExtension: string,
    useHashForCache?: boolean,
    filetype?: string
  ): Promise<DownloadResult>

  /** Download and save a file to a specific target path. */
  static downloadToPath(
    source: string,
    targetPath: string
  ): Promise<DownloadResult>

  /** Fetch multiple highlight queries and concatenate them into a single string. */
  static fetchHighlightQueries(
    sources: string[],
    cacheDir: string,
    filetype: string
  ): Promise<string>
}
```

#### downloadOrLoad()

Downloads a file from a URL or reads from a local path. If `cacheDir` is provided, the file is cached locally. Subsequent calls for the same source return the cached version.

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | `string` | URL or local file path. |
| `cacheDir` | `string` | Base cache directory. |
| `cacheSubdir` | `string` | Subdirectory within the cache (e.g., `"wasm"`, `"queries"`). |
| `fileExtension` | `string` | Expected file extension (e.g., `".wasm"`, `".scm"`). |
| `useHashForCache` | `boolean?` | If `true`, use a hash of the URL as the cache filename. |
| `filetype` | `string?` | Filetype hint for organizing the cache. |

#### downloadToPath()

Downloads a file and saves it to a specific target path. No caching logic -- just a direct download-and-save.

#### fetchHighlightQueries()

Fetches multiple `.scm` query files and concatenates them into a single query string. Used internally when registering parsers whose queries are specified as multiple sources.

---

## Styled Text Conversion

Functions for converting tree-sitter highlights into OpenTUI's styled text system. These are re-exported from the tree-sitter barrel module.

### treeSitterToTextChunks()

```typescript
function treeSitterToTextChunks(
  content: string,
  highlights: SimpleHighlight[],
  syntaxStyle: SyntaxStyle,
  options?: ConcealOptions
): TextChunk[]
```

Converts raw highlight data into an array of `TextChunk` objects (from OpenTUI's text buffer system). Each chunk has the appropriate foreground/background colors applied based on the `SyntaxStyle` theme.

| Parameter | Type | Description |
|-----------|------|-------------|
| `content` | `string` | The source text. |
| `highlights` | `SimpleHighlight[]` | Highlight spans from `highlightOnce()` or events. |
| `syntaxStyle` | `SyntaxStyle` | Syntax theme mapping group names to colors. |
| `options` | `ConcealOptions?` | Whether to apply concealment (replace syntax with display characters). |

### treeSitterToStyledText()

```typescript
function treeSitterToStyledText(
  content: string,
  filetype: string,
  syntaxStyle: SyntaxStyle,
  client: TreeSitterClient,
  options?: TreeSitterToStyledTextOptions
): Promise<StyledText>
```

High-level convenience function that highlights content and converts it to a `StyledText` object in one step. Internally calls `highlightOnce()` and then `treeSitterToTextChunks()`.

```typescript
interface TreeSitterToStyledTextOptions {
  conceal?: ConcealOptions
}

interface ConcealOptions {
  enabled: boolean
}
```

---

## Asset Management

### updateAssets()

```typescript
function updateAssets(options?: Partial<UpdateOptions>): Promise<void>
```

Downloads WASM grammars and `.scm` query files for all configured parsers, then generates a TypeScript module (`default-parsers.ts`) that bundles the parser configurations with local file references.

This is a build-time utility, typically run via:

```bash
bun run ./assets/update.ts
```

### UpdateOptions

```typescript
interface UpdateOptions {
  /** Path to parsers-config.json */
  configPath: string
  /** Directory where .wasm and .scm files will be downloaded */
  assetsDir: string
  /** Path where the generated TypeScript file will be written */
  outputPath: string
}
```

---

## Singleton Access

### getTreeSitterClient()

```typescript
function getTreeSitterClient(): TreeSitterClient
```

Returns the global singleton `TreeSitterClient` instance. Use this when you want a shared client across your application rather than creating and managing your own instance.

```typescript
import { getTreeSitterClient } from "@opentui/core/lib/tree-sitter"

const client = getTreeSitterClient()
await client.initialize()
```

---

## Usage Patterns

### Basic Highlighting

One-shot highlighting for static content:

```typescript
import { TreeSitterClient } from "@opentui/core/lib/tree-sitter"

const client = new TreeSitterClient({ dataPath: "./tree-sitter-data" })
await client.initialize()

const result = await client.highlightOnce(
  `function greet(name: string) {
  return \`Hello, \${name}!\`
}`,
  "typescript"
)

if (result.highlights) {
  for (const [start, end, group, meta] of result.highlights) {
    console.log(`  [${start}:${end}] ${group}${meta?.isInjection ? " (injected)" : ""}`)
  }
}

await client.destroy()
```

### Buffer-Based Incremental Highlighting

For editor-like scenarios with frequent edits:

```typescript
const client = new TreeSitterClient({ dataPath: "./data" })
await client.initialize()

// Listen for highlight updates
client.on("highlights:response", (bufferId, version, highlights) => {
  console.log(`Buffer ${bufferId} v${version}: ${highlights.length} lines`)
  for (const line of highlights) {
    for (const range of line.highlights) {
      console.log(`  Line ${line.line}: [${range.startCol}:${range.endCol}] ${range.group}`)
    }
  }
})

// Create a buffer
const hasParser = await client.createBuffer(1, "const x = 1", "typescript", 0)

// Apply an incremental edit (insert " + 2" at the end)
await client.updateBuffer(
  1,
  [
    {
      startIndex: 11,
      oldEndIndex: 11,
      newEndIndex: 15,
      startPosition: { row: 0, column: 11 },
      oldEndPosition: { row: 0, column: 11 },
      newEndPosition: { row: 0, column: 15 },
    },
  ],
  "const x = 1 + 2",
  1
)

// Clean up
await client.removeBuffer(1)
await client.destroy()
```

### Streaming / LLM Integration

For incrementally highlighting content as it streams in (e.g., from an LLM):

```typescript
const client = new TreeSitterClient({ dataPath: "./data" })
await client.initialize()

let content = ""
let version = 0

// Create an empty buffer
await client.createBuffer(1, "", "typescript", version)

// Listen for highlight updates
client.on("highlights:response", (bufferId, ver, highlights) => {
  // Apply highlights to your code display component
  applyHighlights(highlights)
})

// As chunks arrive from the stream
for await (const chunk of llmStream) {
  const oldLength = content.length
  content += chunk
  version++

  await client.updateBuffer(
    1,
    [
      {
        startIndex: oldLength,
        oldEndIndex: oldLength,
        newEndIndex: content.length,
        startPosition: indexToPosition(content, oldLength),
        oldEndPosition: indexToPosition(content, oldLength),
        newEndPosition: indexToPosition(content, content.length),
      },
    ],
    content,
    version
  )
}
```

### Adding a Custom Language

```typescript
import { TreeSitterClient } from "@opentui/core/lib/tree-sitter"

const client = new TreeSitterClient({ dataPath: "./data" })
await client.initialize()

// Register a custom parser
client.addFiletypeParser({
  filetype: "gleam",
  wasm: "./grammars/tree-sitter-gleam.wasm",
  queries: {
    highlights: ["./queries/highlights-gleam.scm"],
  },
})

// Preload the parser to avoid latency on first use
await client.preloadParser("gleam")

// Now highlight Gleam code
const result = await client.highlightOnce(
  'pub fn main() { io.println("Hello!") }',
  "gleam"
)
```

### Using with Code Component

```typescript
import { TreeSitterClient } from "@opentui/core/lib/tree-sitter"
import { CodeRenderable } from "@opentui/core"

const client = new TreeSitterClient({ dataPath: "./data" })
await client.initialize()

const code = new CodeRenderable(renderer, {
  content: `function hello() { return "world" }`,
  filetype: "typescript",
  syntaxStyle: mySyntaxStyle,
  treeSitterClient: client,
})

renderer.root.add(code)
```

---

## Supported Languages

The default parser configuration includes grammars for common languages. Use `getParsers()` to see the full list at runtime, or `extToFiletype()` / `pathToFiletype()` to check if a specific extension is mapped.

Languages with built-in grammar support include (but are not limited to):

- TypeScript / JavaScript / TSX / JSX
- Python
- Rust
- Go
- C / C++
- Lua
- JSON
- HTML
- CSS
- Markdown (with injection support for fenced code blocks)

The Markdown parser demonstrates injection support, mapping code fence info strings (`js`, `ts`, `javascript`, `typescript`, `md`, `markdown`) to their respective language parsers for nested highlighting.

To add support for additional languages, use `addDefaultParsers()` before initialization or `addFiletypeParser()` after initialization.
