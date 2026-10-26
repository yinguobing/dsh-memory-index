# dsh-memory-index

Full-text memory index for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It indexes the Markdown memory tree you already have — a core `MEMORY.md`, daily notes, a wiki, and archived sessions — into one local SQLite FTS5 database. It adds `memory_search`, `memory_read`, and `memory_write`, plus optional startup recall. No embeddings, no API key, no sidecar process, and no file migration.

> This is the lexical-first release. Semantic retrieval is planned as an additional layer, not a replacement for the file tree.

## Why this one

Most memory plugins ask you to adopt their storage format. This one assumes your memory is already a set of Markdown files and makes that tree searchable:

- **Existing files stay authoritative.** `MEMORY.md`, `memory/YYYY-MM-DD.md`, `wiki/`, and `archive/sessions/` remain ordinary files you can read, edit, `git diff`, or delete.
- **Chinese-friendly retrieval.** FTS5 `trigram` when the SQLite build supports it, with a `unicode61` fallback and CJK 3-gram expansion.
- **History is searchable.** Archived session Markdown can be indexed next to daily notes and long-term memory.
- **Safe defaults.** Read-only, no startup recall, no startup indexing until you ask for it.
- **Local only.** One SQLite file; no network calls and no telemetry.

It is not a replacement for an atomic-fact store, a vector memory service, or an approval-gated `AGENTS.md` editor. It solves a narrower problem: *make the memory tree I already write to searchable from DSH.*

## Install

This package is not published to npm yet. Install it from a local checkout or a packed tarball.

From the local checkout:

```sh
dsh plugin --profile web add "link:/absolute/path/to/dsh-memory-index"
dsh --profile web
```

From the packed tarball:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-memory-index-0.1.0.tgz
dsh --profile web
```

When it is published later, the command becomes:

```sh
dsh plugin --profile web add dsh-memory-index
```

Then set `workspace` in the profile's `cordis.patch.yml` to the directory that contains your memory tree. The bundle's default uses the Harness process directory so installation never guesses a personal path; override it:

```yaml
- id: memory-index
  config:
    workspace: /home/you/notes
    writeMode: readonly
    autoRecall: off
    buildOnStart: false
```

Run `/memory-rebuild` once in a new session, then `/memory-status`.

## Tools

| Tool | Purpose |
|---|---|
| `memory_search` | Search the configured roots; returns `path:line` and a snippet. Optional `scope` limits to one source. |
| `memory_read` | Read a file inside a configured memory root. |
| `memory_write` | Append to today's note, append to the core file, or create/replace a file under a write root. |

Commands: `/memory-status`, `/memory-rebuild` (add `fts` to rebuild the full-text table from scratch).

## Configuration

```yaml
- id: memory-index
  name: dsh-memory-index
  config:
    workspace: /home/you/notes
    indexDb: .memory/index.sqlite
    roots:
      - { path: MEMORY.md, source: core }
      - { path: memory, source: daily }
      - { path: wiki, source: wiki }
      - { path: archive/sessions, source: session }
    writeRoots:
      - MEMORY.md
      - memory
    digest:
      - { path: MEMORY.md, maxChars: 3500 }
      - { path: 'memory/{today}.md', maxChars: 1500 }
      - { path: 'memory/{yesterday}.md', maxChars: 1000 }
    timeZone: Asia/Shanghai
    sourcePriority:
      core: 0
      daily: 1
      wiki: 2
      session: 3
    writeMode: readonly       # readonly | readwrite
    autoRecall: off           # off | startup
    buildOnStart: false
    maxResults: 8
    maxFileBytes: 20971520
    maxWriteBytes: 204800
    maxDigestChars: 8000
```

| Field | Default | Meaning |
|---|---|---|
| `workspace` | required | Directory containing the memory tree. Resolved once and used as the boundary for all reads/writes. |
| `indexDb` | `.memory/index.sqlite` | SQLite file, relative to `workspace`, or `:memory:`. |
| `roots` | `MEMORY.md`, `memory/`, `wiki/`, `archive/sessions/` | Files or directories to index. A file root is indexed directly; a directory root is walked recursively. `source` labels the results. |
| `writeRoots` | `MEMORY.md`, `memory/` | Paths the agent may write. Entries ending in `.md` are files; others are directories. |
| `digest` | `MEMORY.md`, today, yesterday | Optional startup excerpt. `{today}` and `{yesterday}` use `timeZone`. |
| `timeZone` | system zone | Used for daily-note filenames and digest placeholders. |
| `sourcePriority` | `core`, `daily`, `wiki`, `session` | Lower ranks first in ties. Unknown sources sort last. |
| `writeMode` | `readonly` | Set `readwrite` to enable `memory_write`. |
| `autoRecall` | `off` | Set `startup` to add the digest as prompt context for workspace agents. |
| `buildOnStart` | `false` | Build the index in the background after plugin load. |
| `maxResults` | `8` | Default and cap for `memory_search` (`1`–`20`). |
| `maxFileBytes` | 20 MiB | Files larger than this are skipped. |
| `maxWriteBytes` | 200 KiB | Maximum content accepted by one `memory_write`. |
| `maxDigestChars` | 8000 | Character budget for the startup digest. |

`roots` and `writeRoots` are independent on purpose: you can index `wiki/` and `archive/sessions/` while allowing writes only to `memory/`.

## Security model

- Every path is resolved inside `workspace`; `..` and absolute escapes are rejected.
- Existing symlink components are rejected for reads and writes, so a link inside `memory/` cannot redirect a read or a write outside the workspace.
- Reads use `O_NOFOLLOW`; writes create a temporary file with mode `0600`, `fsync`, and rename.
- The core file (`MEMORY.md` by default) is append-only.
- `.env*` files and paths containing `credentials` are excluded from indexing.
- The plugin makes no network requests.

## Search behavior

- With a SQLite build that supports `tokenize='trigram'`, FTS5 handles substring matching; otherwise the table falls back to `unicode61`.
- Queries are segmented with `Intl.Segmenter` when available, then widened with CJK 3-grams if the first pass is too narrow.
- Results are ranked by FTS5 `bm25`, then source priority; a lexical `LIKE` fallback covers short terms and tokenizer gaps.
- Line numbers are chunk start lines, so they are approximate for long chunks.

## Limitations

- **Lexical, not semantic.** It finds words, not meanings. Embedding-based retrieval is planned as an optional layer.
- **No file watcher.** External edits are picked up on the next `/memory-rebuild` or process start with `buildOnStart`. `memory_write` indexes its own write immediately.
- **Single writer.** One process is assumed; SQLite uses a busy timeout, but concurrent writers from multiple processes are not coordinated beyond that.
- **No cross-profile sharing by default.** The database lives under `workspace/.memory/`; choose a shared `indexDb` only if you understand the locking model.
- **`node:sqlite` may print an ExperimentalWarning** on Node 22/24. The package targets `^22.19.0 || >=24.0.0`.
- **Linux is tested.** Windows and macOS paths are implemented but not yet in CI.
- **Approximate citations.** A chunk's `line` is its heading/start line; use `memory_read` when exact context matters.

## Roadmap

- **Semantic layer, optional.** Add embeddings and hybrid ranking behind the same `memory_search` tool; lexical FTS5 remains the offline fallback.
- **Incremental watching.** Replace rebuild-on-demand with a debounced watcher while keeping the manual rebuild command.
- **CI for Windows and macOS.** The path and symlink checks are written cross-platform; Linux is the tested target today.

## Design lineage

The memory model — a core `MEMORY.md`, daily notes, a dream journal, a wiki, and an archived session tree — comes from [OpenClaw](https://github.com/openclaw/openclaw), which is MIT-licensed. This package is an independent DSH implementation of that model; it shares no code with OpenClaw. The goal is to preserve the useful shape of an existing memory tree, not to emulate OpenClaw's runtime.

## Development

```sh
npm install --ignore-scripts
npm test
npm run pack:check
```

Tests use `node:test` against temporary workspaces and cover Chinese/English search, scopes, write modes, path traversal, symlink escapes, digest rendering, and FTS rebuilds.

## License

MIT. See [LICENSE](./LICENSE).
