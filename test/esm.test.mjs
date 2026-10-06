import assert from 'node:assert';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import create, * as namespace from '@nodejs/logger';

const require = createRequire(import.meta.url);

test('ESM and CommonJS share a single instance', () => {
  const cjs = require('@nodejs/logger');
  assert.strictEqual(create, cjs);
  assert.strictEqual(namespace.default, cjs);
  assert.strictEqual(namespace.create, cjs);
});

test('named exports match the CommonJS properties', () => {
  const names = Object.keys(namespace).filter((name) => name !== 'default');
  assert.deepStrictEqual(names.sort(), Object.keys(create).sort());
  for (const name of names) {
    assert.strictEqual(namespace[name], create[name], name);
  }
});
