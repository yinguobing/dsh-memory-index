import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];
const DEFAULT_ROOTS = [
  { path: 'MEMORY.md', source: 'core', extensions: ['.md'] },
  { path: 'memory', source: 'daily', extensions: DEFAULT_TEXT_EXTENSIONS },
  { path: 'wiki', source: 'wiki', extensions: DEFAULT_TEXT_EXTENSIONS },
  { path: 'archive/sessions', source: 'session', extensions: DEFAULT_TEXT_EXTENSIONS },
];
const DEFAULT_WRITE_ROOTS = ['MEMORY.md', 'memory'];
const DEFAULT_DIGEST = [
  { path: 'MEMORY.md', maxChars: 3500 },
  { path: 'memory/{today}.md', maxChars: 1500 },
  { path: 'memory/{yesterday}.md', maxChars: 1000 },
];
const DEFAULT_SOURCE_PRIORITY = { core: 0, daily: 1, wiki: 2, session: 3 };
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.memory', 'assets', 'backups', '__pycache__', '.dreams']);
const SCHEMA_VERSION = 1;
const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 120;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(root, target, label = 'path') {
  if (!isInside(root, target)) {
    throw new Error(`${label} must stay inside the workspace`);
  }
}

/**
 * Reject any existing symlink component below `root`. Missing suffixes are
 * allowed: the caller may create them, but it must re-check afterwards.
 */
function assertNoSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path must stay inside the workspace');
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in memory paths: ${toPosix(path.relative(root, current))}`);
    }
  }
}

function readFileNoFollow(absPath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(absPath, flags);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeExtensions(input) {
  const list = Array.isArray(input) && input.length > 0 ? input : DEFAULT_TEXT_EXTENSIONS;
  return list
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith('.') ? value : `.${value}`));
}

function normalizeRoots(input) {
  const list = Array.isArray(input) && input.length > 0 ? input : DEFAULT_ROOTS;
  return list.map((entry) => {
    if (typeof entry === 'string') {
      return { path: entry, source: 'memory', extensions: DEFAULT_TEXT_EXTENSIONS };
    }
    if (!entry || typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new Error('each root needs a non-empty path');
    }
    const source = typeof entry.source === 'string' && entry.source.trim() !== '' ? entry.source.trim() : 'memory';
    return {
      path: entry.path.trim(),
      source,
      extensions: normalizeExtensions(entry.extensions),
    };
  });
}

function normalizeWriteRoots(input) {
  const list = Array.isArray(input) && input.length > 0 ? input : DEFAULT_WRITE_ROOTS;
  return list
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .map((value) => ({
      path: value,
      kind: value.toLowerCase().endsWith('.md') ? 'file' : 'dir',
    }));
}

function normalizeDigest(input) {
  if (input === false) return [];
  const list = Array.isArray(input) && input.length > 0 ? input : DEFAULT_DIGEST;
  return list.map((entry) => {
    if (typeof entry === 'string') return { path: entry, maxChars: 2000 };
    if (!entry || typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new Error('each digest entry needs a non-empty path');
    }
    return {
      path: entry.path.trim(),
      maxChars: clampInt(entry.maxChars, 1, 20000, 2000),
    };
  });
}

function splitLongText(text, maxChars = MAX_CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < Math.floor(maxChars * 0.45)) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.45)) cut = maxChars;
    const piece = rest.slice(0, cut).trim();
    if (piece) parts.push(piece);
    const nextStart = Math.max(1, cut - overlap);
    rest = rest.slice(nextStart).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkMarkdown(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const sections = [];
  let current = { heading: '', startLine: 1, lines: [] };
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const match = headingRe.exec(lines[index]);
    if (match) {
      const body = current.lines.join('\n').trim();
      if (body) sections.push({ ...current, body });
      current = { heading: match[2].trim(), startLine: index + 1, lines: [] };
    } else {
      current.lines.push(lines[index]);
    }
  }
  const lastBody = current.lines.join('\n').trim();
  if (lastBody) sections.push({ ...current, body: lastBody });
  if (sections.length === 0 && normalized.trim()) {
    sections.push({ heading: '', startLine: 1, body: normalized.trim() });
  }

  const chunks = [];
  for (const section of sections) {
    for (const piece of splitLongText(section.body)) {
      chunks.push({
        heading: section.heading,
        startLine: section.startLine,
        text: piece,
      });
    }
  }
  return chunks;
}

function fallbackTerms(raw) {
  return String(raw ?? '')
    .split(/[\s，。！？、；：,.!?;:()[\]{}"'`]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
}

function queryTerms(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  let parts = [];
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const segment of segmenter.segment(raw)) {
      if (segment.isWordLike) parts.push(segment.segment.trim());
    }
  } catch {
    parts = [];
  }
  if (parts.length === 0) parts = fallbackTerms(raw);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (part && !seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  return (out.length > 0 ? out : [raw]).slice(0, 8);
}

function expandTerms(terms) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const term of terms) {
    add(term);
    const chars = [...term];
    const hasCjk = chars.some((char) => /[\u3400-\u9fff]/u.test(char));
    if (!hasCjk || chars.length < 4) continue;
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      const window = chars.slice(index, index + 3).join('');
      if ([...window].some((char) => /[\u3400-\u9fff]/u.test(char))) add(window);
    }
  }
  return out.slice(0, 10);
}

function makeSnippet(text, terms, maxChars = 700) {
  const lower = text.toLowerCase();
  let at = -1;
  let found = '';
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index >= 0) {
      at = index;
      found = term;
      break;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - Math.floor(maxChars * 0.3));
  const end = Math.min(text.length, start + maxChars);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return { snippet, found };
}

function localDate(timeZone, offsetDays = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86400000));
}

export class MemoryStore {
  constructor(options = {}) {
    const rawWorkspace = options.workspace || process.cwd();
    const resolvedWorkspace = path.resolve(rawWorkspace);
    let workspaceStat;
    try {
      workspaceStat = fs.statSync(resolvedWorkspace);
    } catch {
      throw new Error(`workspace does not exist: ${resolvedWorkspace}`);
    }
    if (!workspaceStat.isDirectory()) throw new Error(`workspace is not a directory: ${resolvedWorkspace}`);
    this.workspace = fs.realpathSync(resolvedWorkspace);

    this.writeMode = options.writeMode === 'readwrite' ? 'readwrite' : 'readonly';
    this.autoRecall = options.autoRecall === 'startup' ? 'startup' : 'off';
    this.timeZone = typeof options.timeZone === 'string' && options.timeZone.trim() !== ''
      ? options.timeZone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      localDate(this.timeZone);
    } catch {
      throw new Error(`invalid timeZone: ${this.timeZone}`);
    }

    this.maxResults = clampInt(options.maxResults, 1, 20, 8);
    this.maxFileBytes = clampInt(options.maxFileBytes, 1024, 64 * 1024 * 1024, 20 * 1024 * 1024);
    this.maxWriteBytes = clampInt(options.maxWriteBytes, 1024, 1024 * 1024, 200 * 1024);
    this.maxDigestChars = clampInt(options.maxDigestChars, 200, 50000, 8000);
    this.exclude = Array.isArray(options.exclude) ? options.exclude.map(String).filter(Boolean) : [];
    this.sourcePriority = { ...DEFAULT_SOURCE_PRIORITY, ...(options.sourcePriority ?? {}) };
    this.roots = normalizeRoots(options.roots);
    this.writeRoots = normalizeWriteRoots(options.writeRoots);
    this.digest = normalizeDigest(options.digest);

    const dbOption = options.indexDb ?? '.memory/index.sqlite';
    this.dbPath = dbOption === ':memory:' ? ':memory:' : path.resolve(this.workspace, String(dbOption));
    if (this.dbPath !== ':memory:') {
      const dbDir = path.dirname(this.dbPath);
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
      try {
        const dbStat = fs.lstatSync(this.dbPath);
        if (dbStat.isSymbolicLink()) throw new Error('indexDb must not be a symbolic link');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }

    this.building = null;
    this.lastError = null;
    this.tokenizer = 'trigram';
    this.digestCache = { signature: '', text: '', at: 0 };
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        ord INTEGER NOT NULL,
        heading TEXT NOT NULL DEFAULT '',
        start_line INTEGER NOT NULL DEFAULT 1,
        end_line INTEGER NOT NULL DEFAULT 1,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);
      CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source);
    `);

    this.ensureFtsTable();
    this.setMeta('schema_version', String(SCHEMA_VERSION));
    this.setMeta('tokenizer', this.tokenizer);
  }

  createFtsTable(tokenizer) {
    this.db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text, path, heading,
        content='chunks', content_rowid='id',
        tokenize='${tokenizer}'
      );
    `);
  }

  ensureFtsTable() {
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get();
    if (existing?.sql) {
      this.tokenizer = /tokenize\s*=\s*'trigram'/i.test(existing.sql) ? 'trigram' : 'unicode61';
      return;
    }
    try {
      this.createFtsTable('trigram');
      this.tokenizer = 'trigram';
    } catch {
      this.createFtsTable('unicode61');
      this.tokenizer = 'unicode61';
    }
  }

  rebuildFts() {
    const preferred = this.tokenizer === 'trigram' ? 'trigram' : 'unicode61';
    this.db.exec('DROP TABLE IF EXISTS chunks_fts');
    try {
      this.createFtsTable(preferred);
      this.tokenizer = preferred;
    } catch {
      this.createFtsTable('unicode61');
      this.tokenizer = 'unicode61';
    }
    const rows = this.db.prepare('SELECT id, text, path, heading FROM chunks ORDER BY id').all();
    const insert = this.db.prepare('INSERT INTO chunks_fts(rowid, text, path, heading) VALUES(?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        insert.run(row.id, row.text, toPosix(path.relative(this.workspace, row.path)), row.heading);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.setMeta('tokenizer', this.tokenizer);
    return { chunks: rows.length, tokenizer: this.tokenizer };
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? row.value : undefined;
  }

  close() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* not fatal */ }
    try { this.db.close(); } catch { /* already closed */ }
  }

  get sources() {
    const seen = new Set();
    for (const root of this.roots) seen.add(root.source);
    return [...seen];
  }

  relativePath(absPath) {
    return toPosix(path.relative(this.workspace, absPath));
  }

  resolvePath(rawPath, options = {}) {
    const raw = String(rawPath ?? '').trim();
    if (!raw) throw new Error('path is required');
    const absPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workspace, raw);
    assertInside(this.workspace, absPath);
    assertNoSymlinkComponents(this.workspace, absPath);
    if (options.mustExist) {
      const stat = fs.lstatSync(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('path must be a regular file');
      }
    }
    return absPath;
  }

  resolveWritePath(rawPath) {
    const absPath = this.resolvePath(rawPath);
    const parent = path.dirname(absPath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(this.workspace, absPath);
    const realParent = fs.realpathSync(parent);
    assertInside(this.workspace, realParent);
    const finalPath = path.join(realParent, path.basename(absPath));
    try {
      const stat = fs.lstatSync(finalPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('write target must be a regular file');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return finalPath;
  }

  isExcluded(absPath) {
    const relative = toPosix(path.relative(this.workspace, absPath));
    const normalized = relative.startsWith('..') ? toPosix(absPath) : `/${relative}`;
    if (normalized.includes('/node_modules/') || normalized.includes('/.git/') || normalized.includes('/.memory/')) return true;
    if (normalized.includes('/__pycache__/')) return true;
    if (/(^|\/)\.env($|\.)/.test(normalized)) return true;
    if (/(^|\/)credentials($|\/|\.)/i.test(normalized)) return true;
    for (const pattern of this.exclude) {
      if (pattern && normalized.includes(pattern)) return true;
    }
    return false;
  }

  rootPath(root) {
    return this.resolvePath(root.path);
  }

  fileSource(absPath) {
    const relative = this.relativePath(absPath);
    let best = null;
    for (const root of this.roots) {
      const rootRelative = toPosix(root.path).replace(/^\.\//, '').replace(/\/+$/, '');
      const isFileRoot = !rootRelative.includes('/') && rootRelative.toLowerCase().endsWith('.md');
      const matches = isFileRoot ? relative === rootRelative : relative === rootRelative || relative.startsWith(`${rootRelative}/`);
      if (matches && (!best || rootRelative.length > best.length)) {
        best = { source: root.source, length: rootRelative.length };
      }
    }
    return best?.source ?? this.roots[0]?.source ?? 'memory';
  }

  isMemoryPath(absPath) {
    if (!isInside(this.workspace, absPath)) return false;
    const relative = this.relativePath(absPath);
    for (const root of this.roots) {
      const rootRelative = toPosix(root.path).replace(/^\.\//, '').replace(/\/+$/, '');
      const isFileRoot = !rootRelative.includes('/') && rootRelative.toLowerCase().endsWith('.md');
      if (isFileRoot ? relative === rootRelative : relative === rootRelative || relative.startsWith(`${rootRelative}/`)) {
        return !this.isExcluded(absPath);
      }
    }
    return false;
  }

  isWriteAllowed(absPath) {
    for (const root of this.writeRoots) {
      const rootRelative = toPosix(root.path).replace(/^\.\//, '').replace(/\/+$/, '');
      const rootAbs = path.resolve(this.workspace, rootRelative);
      if (root.kind === 'file') {
        if (absPath === rootAbs) return true;
      } else if (isInside(rootAbs, absPath)) {
        return true;
      }
    }
    return false;
  }

  async addFile(files, seen, absPath, source) {
    if (seen.has(absPath)) return;
    try {
      const stat = await fs.promises.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > this.maxFileBytes) return;
      if (this.isExcluded(absPath)) return;
      seen.add(absPath);
      files.push({ absPath, source });
    } catch { /* missing */ }
  }

  async collectFiles() {
    const files = [];
    const seen = new Set();

    const walk = async (dir, source, extensions) => {
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name) || this.isExcluded(absPath)) continue;
          await walk(absPath, source, extensions);
          continue;
        }
        if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()) && !this.isExcluded(absPath)) {
          await this.addFile(files, seen, absPath, source);
        }
      }
    };

    for (const root of this.roots) {
      let rootAbs;
      try {
        rootAbs = this.resolvePath(root.path);
      } catch (error) {
        this.lastError = `root rejected: ${root.path}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      let stat;
      try {
        stat = await fs.promises.lstat(rootAbs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        this.lastError = `root is a symbolic link: ${root.path}`;
        continue;
      }
      if (stat.isFile()) {
        await this.addFile(files, seen, rootAbs, root.source);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(rootAbs, root.source, root.extensions);
      }
    }
    return { files, seen };
  }

  async build(options = {}) {
    if (this.building) return this.building;
    this.building = this.#build(options)
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  async #build({ force = false, rebuildFts = false } = {}) {
    const startedAt = Date.now();
    if (rebuildFts) this.rebuildFts();
    const { files, seen } = await this.collectFiles();
    let indexed = 0;
    let unchanged = 0;
    let failed = 0;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        const stat = await fs.promises.stat(file.absPath);
        const existing = this.db.prepare('SELECT bytes, mtime FROM files WHERE path=?').get(file.absPath);
        if (!force && existing && Number(existing.bytes) === stat.size && Number(existing.mtime) === Math.trunc(stat.mtimeMs)) {
          unchanged += 1;
        } else {
          const buffer = await fs.promises.readFile(file.absPath);
          if (buffer.includes(0)) {
            failed += 1;
          } else {
            await this.indexBuffer(file.absPath, file.source, buffer, stat);
            indexed += 1;
          }
        }
      } catch (error) {
        failed += 1;
        this.lastError = `${file.absPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (index % 25 === 24) await yieldToEventLoop();
    }

    const rows = this.db.prepare('SELECT path FROM files').all();
    for (const row of rows) {
      if (!seen.has(row.path) || !fs.existsSync(row.path)) this.deleteFile(row.path);
    }

    this.setMeta('last_built_at', nowIso());
    this.setMeta('last_build_ms', String(Date.now() - startedAt));
    this.setMeta('tokenizer', this.tokenizer);
    this.lastError = failed > 0 ? this.lastError : null;

    return {
      files: files.length,
      indexed,
      unchanged,
      failed,
      chunks: this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c,
      ms: Date.now() - startedAt,
      tokenizer: this.tokenizer,
    };
  }

  indexBuffer(absPath, source, buffer, stat) {
    const text = buffer.toString('utf8');
    const hash = sha256(buffer);
    const chunks = chunkMarkdown(text);
    const relative = this.relativePath(absPath);
    const oldChunks = this.db.prepare('SELECT id, text, path, heading FROM chunks WHERE path=?').all(absPath);

    this.db.exec('BEGIN');
    try {
      const deleteFts = this.db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text, path, heading) VALUES('delete', ?, ?, ?, ?)");
      for (const row of oldChunks) {
        deleteFts.run(row.id, row.text, this.relativePath(row.path), row.heading);
      }
      this.db.prepare('DELETE FROM chunks WHERE path=?').run(absPath);

      const insertChunk = this.db.prepare(`
        INSERT INTO chunks(path, source, ord, heading, start_line, end_line, text)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text, path, heading) VALUES(?, ?, ?, ?)');
      for (let ord = 0; ord < chunks.length; ord += 1) {
        const chunk = chunks[ord];
        const endLine = chunk.startLine + Math.max(1, chunk.text.split('\n').length) - 1;
        const info = insertChunk.run(absPath, source, ord, chunk.heading, chunk.startLine, endLine, chunk.text);
        insertFts.run(Number(info.lastInsertRowid), chunk.text, relative, chunk.heading);
      }
      this.db.prepare(`
        INSERT INTO files(path, source, bytes, mtime, sha256, indexed_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          source=excluded.source, bytes=excluded.bytes, mtime=excluded.mtime,
          sha256=excluded.sha256, indexed_at=excluded.indexed_at
      `).run(absPath, source, stat.size, Math.trunc(stat.mtimeMs), hash, nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteFile(absPath) {
    const rows = this.db.prepare('SELECT id, text, path, heading FROM chunks WHERE path=?').all(absPath);
    this.db.exec('BEGIN');
    try {
      const deleteFts = this.db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, text, path, heading) VALUES('delete', ?, ?, ?, ?)");
      for (const row of rows) {
        deleteFts.run(row.id, row.text, this.relativePath(row.path), row.heading);
      }
      this.db.prepare('DELETE FROM chunks WHERE path=?').run(absPath);
      this.db.prepare('DELETE FROM files WHERE path=?').run(absPath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  indexFile(absPath, source) {
    const stat = fs.statSync(absPath);
    const buffer = fs.readFileSync(absPath);
    if (buffer.includes(0)) return false;
    this.indexBuffer(absPath, source || this.fileSource(absPath), buffer, stat);
    return true;
  }

  search(query, options = {}) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const k = clampInt(options.k, 1, 20, this.maxResults);
    const allowedScopes = ['all', ...this.sources];
    const scope = allowedScopes.includes(options.scope) ? options.scope : 'all';
    const fetchLimit = Math.max(80, k * 8);

    const useFts = this.tokenizer === 'trigram' && terms.every((term) => [...term].length >= 3);
    let rows = [];
    if (useFts) {
      try {
        rows = this.ftsRows(terms, scope, fetchLimit);
      } catch {
        rows = [];
      }
    }
    if (rows.length < k) rows = this.mergeRows(rows, this.likeRows(terms, scope, 'and', fetchLimit));
    if (rows.length < k) rows = this.mergeRows(rows, this.likeRows(terms, scope, 'or', fetchLimit));
    const broad = expandTerms(terms);
    if (rows.length < k && broad.length > terms.length) {
      let broadRows = [];
      try { broadRows = this.ftsRows(broad, scope, 400, 'or'); } catch { broadRows = []; }
      if (broadRows.length > 0) {
        for (const row of broadRows) {
          const hay = `${row.text} ${row.path} ${row.heading}`.toLowerCase();
          row.matched = broad.reduce((count, term) => count + (hay.includes(term.toLowerCase()) ? 1 : 0), 0);
          row.rank = 1000 - row.matched * 10 + (this.sourcePriority[row.source] ?? 99) * 2;
          row.broad = true;
        }
        broadRows.sort((a, b) => a.rank - b.rank);
        rows = this.mergeRows(rows, broadRows);
      } else {
        rows = this.mergeRows(rows, this.likeRows(broad, scope, 'or', fetchLimit));
      }
    }

    const results = [];
    for (const row of rows) {
      const relative = this.relativePath(row.path);
      const { snippet, found } = makeSnippet(row.text, terms);
      const heading = row.heading ? `[${row.heading}] ` : '';
      results.push({
        path: relative.startsWith('..') ? row.path : relative,
        line: Number(row.start_line) || 1,
        heading: row.heading || '',
        source: row.source,
        snippet: found ? snippet : `${heading}${snippet}`,
        score: row.route === 'fts'
          ? Number(row.rank) + (row.broad ? 0 : (this.sourcePriority[row.source] ?? 99) * 100)
          : 1000 - Number(row.matched || 0) * 20 + (this.sourcePriority[row.source] ?? 99) * 5,
      });
    }

    results.sort((a, b) => a.score - b.score);
    const seen = new Set();
    const unique = [];
    for (const result of results) {
      const key = `${result.path}:${result.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(result);
      if (unique.length >= k) break;
    }
    return unique;
  }

  ftsRows(terms, scope, limit, mode = 'and') {
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(mode === 'or' ? ' OR ' : ' AND ');
    const scopeSql = scope === 'all' ? '' : ' AND c.source = ?';
    const params = scope === 'all' ? [match, limit] : [match, scope, limit];
    return this.db.prepare(`
      SELECT c.id, c.path, c.source, c.heading, c.start_line, c.text,
             bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?${scopeSql}
      ORDER BY rank LIMIT ?
    `).all(...params).map((row) => ({ ...row, route: 'fts', matched: terms.length }));
  }

  likeRows(terms, scope, mode, limit) {
    const clause = '(instr(lower(c.text), lower(?)) > 0 OR instr(lower(c.path), lower(?)) > 0 OR instr(lower(c.heading), lower(?)) > 0)';
    const whereTerms = terms.map(() => clause).join(mode === 'and' ? ' AND ' : ' OR ');
    const whereParams = [];
    for (const term of terms) whereParams.push(term, term, term);
    let selectMatched = '0 AS matched';
    let scoreParams = [];
    if (mode === 'or') {
      selectMatched = `${terms.map(() => `(CASE WHEN ${clause} THEN 1 ELSE 0 END)`).join(' + ')} AS matched`;
      for (const term of terms) scoreParams.push(term, term, term);
    }
    const scopeSql = scope === 'all' ? '' : ' AND c.source = ?';
    const scopeParams = scope === 'all' ? [] : [scope];
    const priorityEntries = Object.entries(this.sourcePriority)
      .map(([source, priority]) => [source, Number(priority)])
      .filter(([, priority]) => Number.isFinite(priority));
    const prioritySql = priorityEntries.length > 0 ? priorityEntries.map(() => 'WHEN ? THEN ?').join(' ') : '';
    const priorityParams = priorityEntries.flat();
    return this.db.prepare(`
      SELECT c.id, c.path, c.source, c.heading, c.start_line, c.text, ${selectMatched}
      FROM chunks c
      WHERE (${whereTerms})${scopeSql}
      ORDER BY
        ${prioritySql ? `CASE c.source ${prioritySql} ELSE 99 END` : '99'},
        ${mode === 'or' ? 'matched DESC, ' : ''}length(c.text) ASC, c.path ASC, c.start_line ASC
      LIMIT ?
    `).all(...scoreParams, ...whereParams, ...scopeParams, ...priorityParams, limit).map((row) => ({ ...row, route: 'like' }));
  }

  mergeRows(base, extra) {
    const known = new Set(base.map((row) => row.id));
    return base.concat(extra.filter((row) => !known.has(row.id)));
  }

  read(relPath, options = {}) {
    const absPath = this.resolvePath(relPath, { mustExist: true });
    if (!this.isMemoryPath(absPath)) {
      throw new Error('path is not inside a configured memory root');
    }
    const text = readFileNoFollow(absPath);
    const lines = text.split('\n');
    const offset = clampInt(options.offset, 1, lines.length || 1, 1);
    const limit = clampInt(options.limit, 1, 400, 200);
    const start = offset - 1;
    const end = Math.min(lines.length, start + limit);
    return {
      path: this.relativePath(absPath),
      totalLines: lines.length,
      offset,
      endLine: end,
      text: lines.slice(start, end).join('\n'),
    };
  }

  writeTarget(target) {
    const fileRoot = this.writeRoots.find((root) => root.kind === 'file');
    const dirRoots = this.writeRoots.filter((root) => root.kind === 'dir');
    const raw = String(target ?? '').trim();
    if (!raw) throw new Error('target is required');

    if (raw === 'daily' || raw === 'today') {
      if (dirRoots.length === 0) throw new Error('no directory write root is configured');
      return path.join(dirRoots[0].path, `${this.today()}.md`);
    }
    if (raw === 'MEMORY.md') {
      if (!fileRoot) throw new Error('MEMORY.md is not a configured write root');
      return fileRoot.path;
    }
    if (raw.startsWith('memory/') || raw.startsWith('memory\\')) return raw;
    if (!raw.includes('/') && !raw.includes('\\')) {
      if (dirRoots.length === 0) throw new Error('no directory write root is configured');
      return path.join(dirRoots[0].path, raw.endsWith('.md') ? raw : `${raw}.md`);
    }
    return raw;
  }

  write(target, content, mode = 'append') {
    if (this.writeMode !== 'readwrite') {
      throw new Error('memory writes are disabled (writeMode=readonly)');
    }
    const body = String(content ?? '');
    if (!body.trim()) throw new Error('content is required');
    if (Buffer.byteLength(body, 'utf8') > this.maxWriteBytes) throw new Error('content is too large');
    const normalizedMode = ['append', 'create', 'replace'].includes(mode) ? mode : 'append';
    const relPath = this.writeTarget(target);
    const lexicalPath = this.resolvePath(relPath);
    if (!this.isWriteAllowed(lexicalPath)) {
      throw new Error('writes are limited to configured write roots');
    }
    const absPath = this.resolveWritePath(relPath);
    const appendOnly = this.writeRoots.some((root) => root.kind === 'file' && path.resolve(this.workspace, root.path) === absPath);
    if (appendOnly && normalizedMode !== 'append') {
      throw new Error('the core memory file may only be appended to');
    }

    const exists = fs.existsSync(absPath);
    if (normalizedMode === 'create' && exists) throw new Error('target already exists');
    if (normalizedMode === 'replace' && !exists) throw new Error('target does not exist');

    fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
    let next;
    if (normalizedMode === 'replace') {
      next = body.endsWith('\n') ? body : `${body}\n`;
    } else {
      const existing = exists ? readFileNoFollow(absPath) : '';
      const prefix = existing.trimEnd();
      const inDirectoryRoot = this.writeRoots.some((root) => root.kind === 'dir' && isInside(path.resolve(this.workspace, root.path), absPath));
      const heading = !exists && inDirectoryRoot && path.basename(absPath).match(/^\d{4}-\d{2}-\d{2}\.md$/)
        ? `# ${path.basename(absPath, '.md')}\n\n`
        : '';
      next = `${existing ? `${prefix}\n\n` : heading}${body.trimEnd()}\n`;
    }

    const tempPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, next, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, absPath);

    let indexed = false;
    try {
      indexed = this.indexFile(absPath, this.fileSource(absPath));
    } catch (error) {
      this.lastError = `write indexed failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { path: this.relativePath(absPath), bytes: Buffer.byteLength(next, 'utf8'), indexed };
  }

  today() {
    return localDate(this.timeZone, 0);
  }

  yesterday() {
    return localDate(this.timeZone, -1);
  }

  buildDigest() {
    if (this.digest.length === 0) return '';
    const today = this.today();
    const yesterday = this.yesterday();
    const specs = this.digest.map((entry) => ({
      ...entry,
      path: entry.path.replaceAll('{today}', today).replaceAll('{yesterday}', yesterday),
    }));
    const signature = specs.map((entry) => {
      try {
        const stat = fs.statSync(path.resolve(this.workspace, entry.path));
        return `${entry.path}:${stat.size}:${Math.trunc(stat.mtimeMs)}:${entry.maxChars}`;
      } catch {
        return `${entry.path}:missing:${entry.maxChars}`;
      }
    }).join('|');
    if (signature === this.digestCache.signature && Date.now() - this.digestCache.at < 5000) {
      return this.digestCache.text;
    }

    const parts = ['<memory-digest>', 'These are excerpts from the memory tree. Use memory_search for details.'];
    let used = 0;
    let hasContent = false;
    for (const entry of specs) {
      try {
        const text = readFileNoFollow(this.resolvePath(entry.path, { mustExist: true })).trim();
        if (!text) continue;
        const slice = text.length > entry.maxChars ? `${text.slice(0, entry.maxChars)}…` : text;
        const block = `\n## ${entry.path}\n${slice}`;
        if (used + block.length > this.maxDigestChars) break;
        parts.push(block);
        used += block.length;
        hasContent = true;
      } catch { /* missing digest file */ }
    }
    parts.push('</memory-digest>');
    const result = hasContent ? parts.join('\n') : '';
    this.digestCache = { signature, text: result, at: Date.now() };
    return result;
  }

  status() {
    const files = this.db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
    const chunks = this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c;
    let dbBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { dbBytes += fs.statSync(`${this.dbPath}${suffix}`).size; } catch { /* ignore */ }
    }
    return {
      workspace: this.workspace,
      dbPath: this.dbPath,
      dbBytes,
      files: Number(files),
      chunks: Number(chunks),
      tokenizer: this.tokenizer,
      writeMode: this.writeMode,
      autoRecall: this.autoRecall,
      building: Boolean(this.building),
      lastError: this.lastError,
      lastBuiltAt: this.getMeta('last_built_at') || null,
      lastBuildMs: this.getMeta('last_build_ms') || null,
      sources: this.sources,
      timeZone: this.timeZone,
    };
  }
}

export {
  DEFAULT_DIGEST,
  DEFAULT_ROOTS,
  DEFAULT_SOURCE_PRIORITY,
  DEFAULT_TEXT_EXTENSIONS,
  DEFAULT_WRITE_ROOTS,
  MemoryStore as default,
};
