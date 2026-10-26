# Publishing notes

Status: **npm publication deferred on 2026-10-26.** The package is distributed locally as a tarball for now.

Decisions:

- Name: **`dsh-memory-index`**
- License: **MIT**
- Registry: not published; no npm login required for the local tarball
- Local artifact: `dist/dsh-memory-index-0.1.0.tgz`

## Name candidates

Checked against npm on 2026-10-26. Availability can change; re-check before claiming a name.

| Name | Status | Fit |
|---|---|---|
| `dsh-memory-index` | available | Clear, searchable, and honest for a lexical index that can later add a semantic layer. **Recommended.** |
| `dsh-memory-tree` | available | Emphasizes the existing `MEMORY.md` + `memory/` + `wiki/` + `archive/sessions/` tree. Good if the brand should be about structure, not search. |
| `dsh-memory-atlas` | available | Brandable “map of everything you wrote”; less obvious in npm search. |
| `dsh-memory-lens` | available | Brandable “look into memory”; vague about full-text search. |
| `dsh-recall-index` | available | Retrieval-first wording, but `dsh-recall` already exists and may confuse. |
| `dsh-memory-workspace` | available | Too close to the existing `dsh-workspace-memory`; avoid. |

A scoped name such as `@yourscope/dsh-memory-index` is fine if you want namespace ownership; an unscoped name is easier to discover.

## Why not `dsh-memory`

`dsh-memory` is already published and implements a different model: an atomic-fact SQLite store with `memory_write`, `memory_search`, and `memory_forget`. This package indexes an existing Markdown tree and keeps those files authoritative. The names should not collide.

## Provenance

The memory model (core `MEMORY.md`, daily notes, dream journal, wiki, archived sessions) comes from OpenClaw, which is MIT-licensed. This package is an independent implementation; it shares no OpenClaw code. Keep the “Design lineage” section in both READMEs, and do not use OpenClaw branding or logos.

If any future change copies code from OpenClaw, preserve its MIT copyright notice and add the attribution to `LICENSE` or `NOTICE`.

## Local release checklist

1. `npm test` — currently 14 tests.
2. `npm run pack:check` — confirm only `index.js`, `lib.js`, patch, locales, icon, READMEs, and LICENSE are packed.
3. Confirm the packed tarball contains no `.memory/` database, personal paths, credentials, or test fixtures.
4. `npm pack --pack-destination dist` and record the SHA-256.
5. Install the tarball into an isolated profile with `indexDb: ':memory:'` and boot once.
6. Keep `dist/dsh-memory-index-0.1.0.tgz` as the local artifact; verify it with `cd dist && sha256sum -c SHA256SUMS`.

## If publishing to npm later

1. `npm login` (this machine currently has no npm auth).
2. `npm publish --access public`.
3. Create a GitHub release and tag `v0.1.0`.
4. Optional: publish a market index JSON and add its URL in DSH's Discover tab. DSH has no official market; Discover reads indexes the user adds.

## Versioning

- `0.1.0` — lexical FTS5 index, generic roots, safe defaults.
- `0.2.0` — optional semantic layer / hybrid ranking.
- `0.3.0` — file watching or other incremental indexing.

## Post-publish verification

```sh
dsh plugin --profile memory-test --from-default-profile headless --dump-config
dsh plugin --profile memory-test add dsh-memory-index@0.1.0
dsh --profile memory-test --dump-config-schema | grep -c dsh-memory-index
```

Then boot once with an isolated `workspace` and `indexDb: ':memory:'` to confirm activation without touching live data.
