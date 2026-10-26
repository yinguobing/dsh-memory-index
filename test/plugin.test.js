import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Config, apply } from '../index.js';

function makeContext() {
  const effects = [];
  const commandList = [];
  const sections = [];
  const contexts = [];
  return {
    effects,
    commandList,
    sections,
    contexts,
    effect(fn) {
      const dispose = fn();
      effects.push(dispose);
      return dispose;
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined;
      return {
        section(section) { sections.push(section); return () => {}; },
        context(context) { contexts.push(context); return () => {}; },
      };
    },
    commandsRegistry: null,
    commands: {
      register(definition) { commandList.push(definition); return () => {}; },
    },
    on() { return () => {}; },
  };
}

test('Config requires a workspace and applies safe defaults', () => {
  assert.throws(() => Config({}), /workspace/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-config-'));
  try {
    const config = Config({ workspace: root });
    assert.equal(config.workspace, root);
    assert.equal(config.writeMode, 'readonly');
    assert.equal(config.autoRecall, 'off');
    assert.equal(config.buildOnStart, false);
    assert.equal(config.roots[0].path, 'MEMORY.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Config accepts custom roots and write roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-config-'));
  try {
    const config = Config({
      workspace: root,
      roots: [{ path: 'notes', source: 'notes' }],
      writeRoots: ['notes'],
      timeZone: 'UTC',
    });
    assert.deepEqual(config.roots.map((entry) => entry.path), ['notes']);
    assert.deepEqual(config.writeRoots, ['notes']);
    assert.equal(config.timeZone, 'UTC');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply registers commands, a prompt section, and a digest context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-plugin-'));
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '# Memory\n\nA durable fact.');
  const ctx = makeContext();
  try {
    apply(ctx, { workspace: root, indexDb: ':memory:', autoRecall: 'startup' });
    assert.deepEqual(ctx.commandList.map((command) => command.name), ['memory-status', 'memory-rebuild']);
    assert.equal(ctx.sections.length, 1);
    assert.equal(ctx.sections[0].name, 'memory-index');
    assert.equal(ctx.contexts.length, 1);
    assert.equal(ctx.contexts[0].name, 'memory-index-digest');

    const agent = { session: { header: { cwd: root } } };
    assert.match(ctx.sections[0].text({ scope: agent }), /Memory rules/);
    assert.match(ctx.contexts[0].text({ scope: agent }), /A durable fact/);
    assert.equal(ctx.sections[0].text({ scope: { session: { header: { cwd: '/tmp/other' } } } }), '');
    assert.equal(ctx.contexts[0].text({ scope: { session: { header: { cwd: '/tmp/other' } } } }), '');
  } finally {
    for (const dispose of ctx.effects) dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
