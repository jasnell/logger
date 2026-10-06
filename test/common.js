'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const loggerPath = path.resolve(__dirname, '..', 'lib', 'logger.js');

/**
 * Returns a function wrapping `fn` that must be called exactly `exact` times
 * before the test `t` completes.
 * @param {import('node:test').TestContext} t
 * @param {Function} [fn]
 * @param {number} [exact]
 * @returns {Function}
 */
function mustCall(t, fn = () => {}, exact = 1) {
  if (typeof fn === 'number') {
    exact = fn;
    fn = () => {};
  }
  const mocked = t.mock.fn(fn);
  t.after(() => {
    assert.strictEqual(mocked.mock.callCount(), exact,
                       `expected ${exact} call(s) to ${fn.name || 'function'}`);
  });
  return mocked;
}

/**
 * Returns a function that fails the test `t` if it is ever called.
 * @param {import('node:test').TestContext} t
 * @returns {Function}
 */
function mustNotCall(t) {
  return mustCall(t, function mustNotCall() {}, 0);
}

/**
 * Runs `script` in a new Node.js process, with `logger` bound to the module.
 * @param {string} script
 * @param {string[]} [execArgv]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runScript(script, execArgv = []) {
  const source = `const logger = require(${JSON.stringify(loggerPath)});\n` +
    script;
  return spawnSync(process.execPath, [...execArgv, '-e', source], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

module.exports = {
  loggerPath,
  mustCall,
  mustNotCall,
  runScript,
};
