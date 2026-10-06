'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { inspect } = require('node:util');
const { runScript } = require('./common');
const { ConsoleProvider, levels } = require('..');

function run(destination, level, statement, options = {}) {
  return runScript(`
    const { ConsoleProvider, create } = logger;
    const provider = new ConsoleProvider({
      destination: ${JSON.stringify(destination)},
      level: ${JSON.stringify(level)},
      sync: true,
      ...${JSON.stringify(options)},
    });
    const log = create(provider, {
      name: 'example',
      bindings: { service: 'api' },
    });
    ${statement}
    provider.flushSync();
  `);
}

test('writes nested JSON records to stdout', () => {
  const result = run(
    'stdout',
    'debug',
    "log.trace('filtered'); log.info('started', { port: 3000 });",
  );

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.strictEqual(event.message, 'started');
  assert.strictEqual(event.name, 'example');
  assert.deepStrictEqual(event.level, { name: 'info', value: 30 });
  assert.deepStrictEqual(event.bindings, { service: 'api' });
  assert.deepStrictEqual(event.attributes, { port: 3000 });
  assert.strictEqual(typeof event.timestamp, 'number');
  assert.strictEqual('pid' in event, false);
});

test('flattened records give event properties precedence', () => {
  const result = run(
    'stdout',
    'info',
    `
      log.info('flattened', {
        level: 'attribute level',
        levelName: 'attribute name',
        message: 'attribute message',
        name: 'attribute name',
        pid: -1,
        requestId: 1,
        service: 'worker',
        timestamp: 0,
      });
    `,
    { flatten: true, pid: true },
  );

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.strictEqual('attributes' in event, false);
  assert.strictEqual('bindings' in event, false);
  assert.strictEqual(event.level, 30);
  assert.strictEqual(event.levelName, 'info');
  assert.strictEqual(event.message, 'flattened');
  assert.strictEqual(event.name, 'example');
  assert.ok(event.pid > 0);
  assert.strictEqual(event.requestId, 1);
  assert.strictEqual(event.service, 'worker');
  assert.ok(event.timestamp > 0);
});

test('flattened pid attribute is preserved when pid is disabled', () => {
  const result = run(
    'stdout',
    'info',
    "log.info('flattened', { pid: 'attribute pid' });",
    { flatten: true },
  );

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.strictEqual(event.pid, 'attribute pid');
});

test('pid option', () => {
  const result = runScript(`
    const { ConsoleProvider, create } = logger;
    const provider = new ConsoleProvider({ pid: true, sync: true });
    create(provider).info('with pid');
    provider.flushSync();
  `);

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.strictEqual(event.message, 'with pid');
  assert.ok(Number.isInteger(event.pid));
  assert.ok(event.pid > 0);
});

test('writes to stderr', () => {
  const result = run(
    'stderr',
    'error',
    "log.warn('filtered'); log.error('failed');",
  );

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  const event = JSON.parse(result.stderr);
  assert.strictEqual(event.message, 'failed');
  assert.deepStrictEqual(event.level, { name: 'error', value: 50 });
});

test('default serializer handles BigInt, errors, and cycles', () => {
  const result = run(
    'stdout',
    'trace',
    `
      const shared = { value: 1 };
      const message = {
        bigint: 9007199254740993n,
        error: Object.assign(new Error('boom'), { code: 'ERR_TEST' }),
        first: shared,
        second: shared,
      };
      message.self = message;
      log.info(message);
    `,
  );

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  const event = JSON.parse(result.stdout);
  assert.strictEqual(event.message.bigint, '9007199254740993');
  assert.strictEqual(event.message.error.name, 'Error');
  assert.strictEqual(event.message.error.message, 'boom');
  assert.match(event.message.error.stack, /^Error: boom/);
  assert.strictEqual(event.message.error.code, 'ERR_TEST');
  assert.deepStrictEqual(event.message.first, { value: 1 });
  assert.deepStrictEqual(event.message.second, { value: 1 });
  assert.strictEqual(event.message.self, '[Circular]');
});

test('custom serializer', () => {
  const result = runScript(`
    const { ConsoleProvider, create } = logger;
    const { inspect } = require('node:util');
    const provider = new ConsoleProvider({ serializer: inspect, sync: true });
    const cyclic = { value: 1n };
    cyclic.self = cyclic;
    create(provider).info('inspected', { cyclic });
    provider.flushSync();
  `);

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /message: 'inspected'/);
  assert.match(result.stdout, /value: 1n/);
  assert.match(result.stdout, /\[Circular \*\d+\]/);
});

test('accessors', () => {
  const provider = new ConsoleProvider({ flatten: true, serializer: inspect });
  assert.strictEqual(provider.destination, 'stdout');
  assert.strictEqual(provider.flatten, true);
  assert.strictEqual(provider.pid, false);
  assert.strictEqual(provider.serializer, inspect);
  assert.strictEqual(provider.level, levels.info);
  assert.strictEqual(typeof provider.stream.write, 'function');

  provider.level = 'warn';
  assert.strictEqual(provider.level, levels.warn);

  const customLevel = { name: 'notice', value: 35 };
  provider.level = customLevel;
  customLevel.value = 0;
  assert.strictEqual(provider.level.name, 'notice');
  assert.strictEqual(provider.level.value, 35);
  assert.strictEqual(Object.isFrozen(provider.level), true);
});

test('option validation', () => {
  assert.throws(
    () => new ConsoleProvider(null),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new ConsoleProvider({ destination: 'file' }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
  assert.throws(
    () => new ConsoleProvider({ serializer: 'json' }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new ConsoleProvider({ flatten: 1 }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new ConsoleProvider({ pid: 1 }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );

  const provider = new ConsoleProvider();
  assert.throws(
    () => { provider.level = 'unknown'; },
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
});

test('serializer must return a string', () => {
  const provider = new ConsoleProvider({ serializer: () => null });
  assert.throws(
    () => provider.log({ level: { value: 30 } }),
    {
      code: 'ERR_INVALID_RETURN_VALUE',
      message: 'Expected a string to be returned from the "serializer" ' +
               'function but got null.',
    },
  );
});

// The exact timing of the flush() callback, and flushSync() throwing while an
// asynchronous write is in progress, depend on fs.Utf8Stream fixes landing in
// Node.js core (nodejs/node#66473), so they are not asserted here.
test('asynchronous flush', () => {
  const result = runScript(`
    const assert = require('node:assert');
    const { ConsoleProvider, create } = logger;
    const provider = new ConsoleProvider();
    const log = create(provider);
    let flushed = false;

    process.on('beforeExit', () => assert.strictEqual(flushed, true));

    log.info('asynchronous flush');
    provider.flush((error) => {
      flushed = true;
      assert.ifError(error);
    });
  `);

  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  assert.strictEqual(JSON.parse(result.stdout).message, 'asynchronous flush');
});
