'use strict';

// Checks that every benchmark runs, with a minimal number of iterations.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const dir = path.resolve(__dirname, '..', 'benchmark');
const exclude = new Set(['common.js', 'run.js']);

for (const name of readdirSync(dir)) {
  if (!name.endsWith('.js') || exclude.has(name)) continue;
  test(`benchmark/${name}`, () => {
    const result = spawnSync(process.execPath, [path.join(dir, name)], {
      env: { ...process.env, NODEJS_LOGGER_BENCHMARK_SMOKE: '1' },
      encoding: 'utf8',
    });
    assert.strictEqual(result.stderr, '');
    assert.strictEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /failed/);
  });
}
