'use strict';

// The internal errors mirror Node.js core's errors with the same codes.

const assert = require('node:assert');
const { test } = require('node:test');
const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_INVALID_STATE,
    ERR_INVALID_THIS,
    ERR_OUT_OF_RANGE,
  },
} = require('../lib/internal/errors');

test('errors have core-compatible shape', () => {
  const error = new ERR_INVALID_ARG_TYPE('options', 'Object', null);
  assert.ok(error instanceof TypeError);
  assert.strictEqual(error.name, 'TypeError');
  assert.strictEqual(error.code, 'ERR_INVALID_ARG_TYPE');
  assert.deepStrictEqual(Object.keys(error), ['code']);
  assert.strictEqual(
    error.message,
    'The "options" argument must be of type object. Received null');
  assert.strictEqual(String(error),
                     `TypeError [ERR_INVALID_ARG_TYPE]: ${error.message}`);
  assert.match(error.stack, /^TypeError \[ERR_INVALID_ARG_TYPE\]: The /);
  assert.doesNotMatch(error.stack, /NodeError/);
});

test('ERR_INVALID_ARG_TYPE messages', () => {
  const cases = [
    [['a', 'string', 1], 'The "a" argument must be of type string. ' +
      'Received type number (1)'],
    [['a.b', 'Function', undefined], 'The "a.b" property must be of type ' +
      'function. Received undefined'],
    [['a', 'Array', {}], 'The "a" argument must be an instance of Array. ' +
      'Received an instance of Object'],
    [['a', 'Provider', 1], 'The "a" argument must be an instance of ' +
      'Provider. Received type number (1)'],
    [['a', ['string', 'number'], true], 'The "a" argument must be one of ' +
      'type string or number. Received type boolean (true)'],
    [['a', 'string', 'x'.repeat(30)], 'The "a" argument must be of type ' +
      `string. Received type string ('${'x'.repeat(25)}...')`],
    [['a', 'string', function fn() {}], 'The "a" argument must be of type ' +
      'string. Received function fn'],
    [['a', 'string', { __proto__: null }], 'The "a" argument must be of ' +
      'type string. Received [Object: null prototype] {}'],
  ];
  for (const [args, message] of cases) {
    assert.strictEqual(new ERR_INVALID_ARG_TYPE(...args).message, message);
  }
});

test('other messages', () => {
  assert.strictEqual(
    new ERR_INVALID_ARG_VALUE('level', 'x', "must be one of: 'info'").message,
    "The argument 'level' must be one of: 'info'. Received 'x'");
  assert.strictEqual(
    new ERR_INVALID_RETURN_VALUE('a string', 'serializer', 1).message,
    'Expected a string to be returned from the "serializer" function but ' +
    'got type number (1).');
  const state = new ERR_INVALID_STATE('busy');
  assert.strictEqual(state.name, 'Error');
  assert.strictEqual(state.message, 'Invalid state: busy');
  assert.strictEqual(new ERR_INVALID_THIS('Logger').message,
                     'Value of "this" must be of type Logger');
  const range = new ERR_OUT_OF_RANGE('v', 'an integer', 2 ** 40);
  assert.ok(range instanceof RangeError);
  assert.strictEqual(range.message, 'The value of "v" is out of range. ' +
                     'It must be an integer. Received 1_099_511_627_776');
});
