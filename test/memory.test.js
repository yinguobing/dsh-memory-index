import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../lib.js';

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-index-'));
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'MEMORY.md'), [
    '# Memory',
    '',
    '## Health',
    '幽门螺杆菌复查安排在 2026-10-20。',
    '',
    '## Work',
    'Robin is migrating the assistant runtime from OpenClaw to DSH.',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'memory', '2026-10-26.md'), [
    '# 2026-10-26',
    '',
    '今天调试记忆插件。',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'wiki', 'dsh.md'), 'DSH is a Cordis-based harness.');
  fs.writeFileSync(path.join(root, 'archive', 'sessions', 's1.md'), 'We discussed the migration plan.');
  fs.writeFileSync(path.join(root, 'DREAMS.md'), 'A dream about flying.');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=not-indexed');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.md'), 'not indexed');
  return root;
}

function open(root, overrides = {}) {
  return new MemoryStore({
    workspace: root,
    indexDb: path.join(root, '.memory', 'index.sqlite'),
    timeZone: 'Asia/Shanghai',
    writeMode: 'readwrite',
    autoRecall: 'off',
    ...overrides,
  });
}

test('builds only configured roots and excludes secrets', async (t) => {
  const root = makeWorkspace();
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const stats = await store.build();
  assert.equal(stats.files, 4);
  assert.equal(stats.failed, 0);
  assert.ok(stats.chunks >= 4);
  assert.equal(store.lastError, null);

  const all = store.search('migration', { k: 5 });
  assert.ok(all.some((r) => r.path === 'MEMORY.md' || r.path === 'archive/sessions/s1.md'));
  assert.ok(!all.some((r) => r.path === 'DREAMS.md'));
  assert.ok(!all.some((r) => r.path === '.env'));
});

test('searches Chinese and English with scopes', async (t) => {
  const root = makeWorkspace();
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.build();

  const health = store.search('幽门螺杆菌', { k: 5 });
  assert.ok(health.length > 0);
  assert.equal(health[0].path, 'MEMORY.md');
  assert.match(health[0].snippet, /幽门螺杆菌/);

  const daily = store.search('调试', { k: 5, scope: 'daily' });
  assert.ok(daily.length > 0);
  assert.equal(daily[0].path, 'memory/2026-10-26.md');

  const wrongScope = store.search('幽门螺杆菌', { k: 5, scope: 'wiki' });
  assert.equal(wrongScope.length, 0);
});

test('reads and writes within memory roots only', async (t) => {
  const root = makeWorkspace();
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.build();

  const read = store.read('MEMORY.md', { offset: 1, limit: 3 });
  assert.equal(read.path, 'MEMORY.md');
  assert.match(read.text, /# Memory/);

  const daily = store.write('daily', 'New daily fact.', 'append');
  assert.equal(daily.path, `memory/${store.today()}.md`);
  assert.equal(daily.indexed, true);
  assert.match(store.read(daily.path).text, /New daily fact/);

  const created = store.write('topic-note', '# Topic\n\nA durable topic.', 'create');
  assert.equal(created.path, 'memory/topic-note.md');
  assert.throws(() => store.write('topic-note', 'again', 'create'), /already exists/);
  store.write('topic-note', '# Topic\n\nReplaced.', 'replace');
  assert.match(store.read('memory/topic-note.md').text, /Replaced/);

  store.write('MEMORY.md', 'A stable fact.', 'append');
  assert.match(store.read('MEMORY.md').text, /A stable fact/);
  assert.throws(() => store.write('MEMORY.md', 'replace', 'replace'), /only be appended/);
  assert.throws(() => store.write('wiki/dsh.md', 'no', 'append'), /write roots/);
});

test('rejects path traversal and absolute escapes', async (t) => {
  const root = makeWorkspace();
  const outside = path.join(path.dirname(root), 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); });

  assert.throws(() => store.read('../outside.txt'), /inside the workspace/);
  assert.throws(() => store.read(path.join(root, '..', 'outside.txt')), /inside the workspace/);
  assert.throws(() => store.write('../outside.md', 'x', 'create'), /inside the workspace/);
  assert.throws(() => store.read('MEMORY.md/child'), /ENOTDIR|regular file|symbolic/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('rejects symbolic-link escapes', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.md');
  fs.writeFileSync(outsideFile, 'outside secret');
  fs.symlinkSync(outsideFile, path.join(root, 'memory', 'link-out.md'));
  fs.symlinkSync(outsideDir, path.join(root, 'memory', 'outdir'));
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outsideDir, { recursive: true, force: true }); });

  assert.throws(() => store.read('memory/link-out.md'), /symbolic links/);
  assert.throws(() => store.write('memory/outdir/pwn.md', 'pwn', 'create'), /symbolic links/);
  assert.equal(fs.existsSync(path.join(outsideDir, 'pwn.md')), false);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside secret');
});

test('skips a root that is a symbolic link', { skip: process.platform === 'win32' }, async (t) => {
  const root = makeWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-root-outside-'));
  fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'outside root');
  fs.symlinkSync(outsideDir, path.join(root, 'linked-root'));
  const store = open(root, { roots: [{ path: 'linked-root', source: 'external' }] });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outsideDir, { recursive: true, force: true }); });
  const stats = await store.build();
  assert.equal(stats.files, 0);
  assert.equal(store.search('outside', { k: 5 }).length, 0);
});

test('handles an empty sourcePriority map', async (t) => {
  const root = makeWorkspace();
  const store = open(root, { sourcePriority: {} });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.build();
  assert.ok(store.search('migration', { k: 5 }).length > 0);
});

test('readonly mode blocks writes', async (t) => {
  const root = makeWorkspace();
  const readwrite = open(root);
  await readwrite.build();
  readwrite.close();
  const store = open(root, { writeMode: 'readonly' });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.throws(() => store.write('daily', 'no', 'append'), /disabled/);
});

test('enforces write size limits', async (t) => {
  const root = makeWorkspace();
  const store = open(root, { maxWriteBytes: 1024 });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => store.write('daily', 'x'.repeat(2048), 'append'), /too large/);
});

test('builds a digest and can rebuild the FTS table', async (t) => {
  const root = makeWorkspace();
  const store = open(root, { autoRecall: 'startup' });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.build();
  store.write('daily', '今天调试记忆插件。', 'append');

  const digest = store.buildDigest();
  assert.match(digest, /<memory-digest>/);
  assert.match(digest, /幽门螺杆菌/);
  assert.match(digest, /今天调试记忆插件/);

  const before = store.status();
  const rebuilt = store.rebuildFts();
  assert.ok(rebuilt.chunks > 0);
  assert.ok(['trigram', 'unicode61'].includes(rebuilt.tokenizer));
  assert.ok(store.search('migration', { k: 3 }).length > 0);
  assert.equal(store.status().chunks, before.chunks);
});

test('reports status with database size', async (t) => {
  const root = makeWorkspace();
  const store = open(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.build();
  const status = store.status();
  assert.equal(status.workspace, fs.realpathSync(root));
  assert.ok(status.files >= 4);
  assert.ok(status.chunks > 0);
  assert.ok(status.dbBytes > 0);
  assert.ok(['trigram', 'unicode61'].includes(status.tokenizer));
});
