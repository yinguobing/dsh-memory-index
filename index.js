import path from 'node:path';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_DIGEST,
  DEFAULT_ROOTS,
  DEFAULT_SOURCE_PRIORITY,
  DEFAULT_WRITE_ROOTS,
  MemoryStore,
} from './lib.js';

export const name = 'memory-index';
export const inject = ['tools', 'commands'];

const RootSchema = z.object({
  path: z.string().required(),
  source: z.string().default('memory'),
  extensions: z.array(z.string()).default(['.md', '.markdown', '.txt']),
});

const DigestSchema = z.object({
  path: z.string().required(),
  maxChars: z.number().default(2000),
});

export const Config = z.object({
  workspace: z.string().required(),
  indexDb: z.string().default('.memory/index.sqlite'),
  roots: z.array(RootSchema).default(DEFAULT_ROOTS),
  writeRoots: z.array(z.string()).default(DEFAULT_WRITE_ROOTS),
  digest: z.array(DigestSchema).default(DEFAULT_DIGEST),
  timeZone: z.string(),
  sourcePriority: z.dict(z.number()).default(DEFAULT_SOURCE_PRIORITY),
  exclude: z.array(z.string()).default([]),
  writeMode: z.union([z.const('readonly'), z.const('readwrite')]).default('readonly'),
  autoRecall: z.union([z.const('off'), z.const('startup')]).default('off'),
  buildOnStart: z.boolean().default(false),
  maxResults: z.number().default(8),
  maxFileBytes: z.number().default(20 * 1024 * 1024),
  maxWriteBytes: z.number().default(200 * 1024),
  maxDigestChars: z.number().default(8000),
});

function isWorkspaceAgent(agent, workspace) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return false;
  const resolved = path.resolve(cwd);
  return resolved === workspace || resolved.startsWith(workspace + path.sep);
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value?.text ?? '') }];
    },
  };
}

function makeMemoryMessage(text, form) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'memory-index', form },
  };
}

function formatSearchResults(results) {
  if (results.length === 0) {
    return 'No matching memory found. Try another keyword, or read the core memory file with memory_read.';
  }
  const lines = [`Found ${results.length} memory chunks (best match first):`];
  results.forEach((result, index) => {
    const heading = result.heading ? ` · ${result.heading}` : '';
    lines.push(`\n[${index + 1}] ${result.path}:${result.line} (${result.source}${heading})`);
    lines.push(result.snippet);
  });
  lines.push('\nCite the path:line above. If a result looks stale, verify it against the current file.');
  return lines.join('\n');
}

function formatReadResult(result) {
  return [
    `path: ${result.path}`,
    `lines: ${result.offset}-${result.endLine} / ${result.totalLines}`,
    '',
    result.text,
  ].join('\n');
}

function formatStatus(status) {
  return [
    `Memory index: ${status.files} files / ${status.chunks} chunks`,
    `Database: ${status.dbPath} (${(status.dbBytes / 1024 / 1024).toFixed(1)} MB)`,
    `Tokenizer: ${status.tokenizer}`,
    `Sources: ${status.sources.join(', ')}`,
    `Time zone: ${status.timeZone}`,
    `Write mode: ${status.writeMode}`,
    `Auto recall: ${status.autoRecall}`,
    `Last build: ${status.lastBuiltAt || 'never'}`,
    `Building: ${status.building ? 'yes' : 'no'}`,
    `Last error: ${status.lastError || 'none'}`,
  ].join('\n');
}

function createTools(store) {
  const scopes = ['all', ...store.sources];
  const searchTool = {
    name: 'memory_search',
    description: 'Search the workspace memory tree: the core memory file, daily notes, wiki pages, and archived sessions. Use it before answering questions about the user, their preferences, relationships, plans, health, work, or past events. Results carry a path:line citation; do not invent memories.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search words, in any language. Multiple words are allowed.' },
        k: { type: 'integer', description: 'Maximum results, 1-20; defaults to the configured value.' },
        scope: {
          type: 'string',
          enum: scopes,
          description: 'Limit to one source, or use all.',
        },
      },
      required: ['query'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const results = store.search(query, { k: args?.k, scope: args?.scope });
      return { text: formatSearchResults(results) };
    },
  };

  const readTool = {
    name: 'memory_read',
    description: 'Read a file from a configured memory root (for example the core memory file, a daily note, a wiki page, or an archived session). Get the path from memory_search first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, for example MEMORY.md or memory/2026-10-26.md.' },
        offset: { type: 'integer', description: 'First line, 1-based; defaults to 1.' },
        limit: { type: 'integer', description: 'Maximum lines, 1-400; defaults to 200.' },
      },
      required: ['path'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    timeoutMs: 15000,
    async execute(args) {
      const result = store.read(args?.path, { offset: args?.offset, limit: args?.limit });
      return { text: formatReadResult(result) };
    },
  };

  const writeTool = {
    name: 'memory_write',
    description: 'Write to the memory tree. By default this appends to today\'s daily note; it can also append to the core memory file or create/replace a file under a configured write root. Read before writing. Never write secrets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'daily/today for today\'s note; MEMORY.md for the core file; or a path/topic name under a write root.' },
        content: { type: 'string', description: 'Markdown content to write.' },
        mode: { type: 'string', enum: ['append', 'create', 'replace'], description: 'Defaults to append. The core memory file only supports append.' },
      },
      required: ['target', 'content'],
    },
    output: textOutput(),
    isConcurrencySafe: () => false,
    timeoutMs: 30000,
    async execute(args) {
      const result = store.write(args?.target, args?.content, args?.mode);
      return {
        text: `Wrote ${result.path} (${result.bytes} bytes)${result.indexed ? '; index updated' : '; index will update on the next build'}.`,
      };
    },
  };

  return [searchTool, readTool, writeTool];
}

const MEMORY_RULES = [
  'Memory rules:',
  '- Before answering questions about the user, their preferences, relationships, plans, health, work, or past events, call `memory_search` first.',
  '- Use `memory_read` when the snippet is not enough; results carry `path:line`, so cite the source.',
  '- Use `memory_write` for durable facts: append to today\'s daily note by default; append only stable facts to the core memory file.',
  '- Never write secrets or credentials into memory.',
].join('\n');

export function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig ?? {});
  const workspace = path.resolve(config.workspace);
  const store = new MemoryStore({
    ...config,
    workspace,
  });

  ctx.effect(() => () => store.close());

  const systemPrompt = ctx.get('systemPrompt');
  let digestContextRegistered = false;
  if (systemPrompt) {
    systemPrompt.section({
      name: 'memory-index',
      order: 9000,
      text: (context) => (isWorkspaceAgent(context?.scope, store.workspace) ? MEMORY_RULES : ''),
    });
    if (store.autoRecall !== 'off' && typeof systemPrompt.context === 'function') {
      systemPrompt.context({
        name: 'memory-index-digest',
        order: 9000,
        required: false,
        text: (context) => (isWorkspaceAgent(context?.scope, store.workspace) ? store.buildDigest() : ''),
      });
      digestContextRegistered = true;
    }
  }

  ctx.commands.register({
    name: 'memory-status',
    description: 'Show memory index status: files, chunks, tokenizer, write mode, and last build.',
    handler: async () => ({ kind: 'success', text: formatStatus(store.status()) }),
  });

  ctx.commands.register({
    name: 'memory-rebuild',
    description: 'Rebuild the memory index. Add "fts" to rebuild the full-text table from scratch.',
    handler: async (invocation) => {
      try {
        const rebuildFts = String(invocation?.rawInput ?? '').trim().toLowerCase() === 'fts';
        const stats = await store.build({ force: true, rebuildFts });
        return {
          kind: 'success',
          text: `Index rebuilt: ${stats.files} files, ${stats.chunks} chunks, ${stats.ms} ms, tokenizer ${stats.tokenizer}.\n\n${formatStatus(store.status())}`,
        };
      } catch (error) {
        return { kind: 'error', text: `Index rebuild failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  if (config.buildOnStart) {
    const warmup = setTimeout(() => {
      store.build().catch((error) => {
        store.lastError = error instanceof Error ? error.message : String(error);
      });
    }, 1200);
    ctx.effect(() => () => clearTimeout(warmup));
  }

  const installed = new WeakSet();
  ctx.on('agent/created', async (payload) => {
    const agent = payload?.agent;
    if (!agent || !isWorkspaceAgent(agent, store.workspace) || installed.has(agent)) return;
    installed.add(agent);
    try {
      for (const tool of createTools(store)) {
        agent.ctx.effect(() => {
          const dispose = agent.ctx.tools.register(tool);
          return () => dispose();
        }, `${name}:${tool.name}`);
      }
      if (store.autoRecall !== 'off' && !digestContextRegistered) {
        const digest = store.buildDigest();
        if (digest) agent.inject(makeMemoryMessage(digest, 'digest'));
      }
    } catch (error) {
      store.lastError = error instanceof Error ? error.message : String(error);
    }
  });
}
