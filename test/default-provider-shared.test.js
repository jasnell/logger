'use strict';

// The default provider is shared by every copy of the package loaded in the
// process, through a registry symbol on globalThis.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loggerPath } = require('./common');

const kStateKey = Symbol.for('nodejs.logger.defaultProviderState');

function loadCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodejs-logger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.dirname(loggerPath), path.join(dir, 'lib'),
            { recursive: true });
  return require(path.join(dir, 'lib', 'logger.js'));
}

test('copies of the package share the default provider', (t) => {
  const first = require('..');
  const second = loadCopy(t);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.EventProvider, second.EventProvider);

  const original = first.getDefaultProvider();
  assert.strictEqual(second.getDefaultProvider(), original);

  const provider = new second.EventProvider();
  const events = [];
  provider.on('log', (event) => events.push(event));
  second.setDefaultProvider(provider);
  try {
    assert.strictEqual(first.getDefaultProvider(), provider);
    const logger = first.create({ name: 'shared' });
    assert.strictEqual(logger.provider, provider);
    logger.info('through the first copy');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].message, 'through the first copy');
  } finally {
    first.setDefaultProvider(original);
  }
  assert.strictEqual(second.getDefaultProvider(), original);
});

test('the shared state is not enumerable or replaceable', () => {
  require('..');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, kStateKey);
  assert.strictEqual(descriptor.enumerable, false);
  assert.strictEqual(descriptor.writable, false);
  assert.strictEqual(descriptor.configurable, false);
  assert.strictEqual(Object.getPrototypeOf(Object.getPrototypeOf(
    descriptor.value)), null);
});

test('incompatible shared state is ignored', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert');
    const key = Symbol.for('nodejs.logger.defaultProviderState');
    const foreign = { version: 999, provider: 'bogus' };
    globalThis[key] = foreign;
    const logger = require(${JSON.stringify(loggerPath)});
    const provider = logger.getDefaultProvider();
    assert.ok(provider instanceof logger.ConsoleProvider);
    logger.setDefaultProvider(new logger.EventProvider());
    assert.strictEqual(foreign.provider, 'bogus');
    assert.strictEqual(globalThis[key], foreign);
  `], { encoding: 'utf8' });
  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
});
