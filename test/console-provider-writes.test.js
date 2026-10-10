'use strict';

// When ConsoleProvider writes records, at exit, and from multiple threads.

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const { loggerPath, runScript } = require('./common');

const stdioLockPath =
  path.resolve(__dirname, '..', 'lib', 'internal', 'logger', 'stdio-lock.js');

function messages(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    return line.startsWith('{') ? JSON.parse(line).message : line;
  });
}

function check(result) {
  assert.strictEqual(result.stderr, '');
  assert.strictEqual(result.status, 0);
  return messages(result.stdout);
}

test('records are written at the end of the turn by default', () => {
  const result = runScript(`
    const fs = require('node:fs');
    const log = logger.create(new logger.ConsoleProvider());
    log.info('a');
    log.info('b');
    fs.writeSync(1, 'same turn\\n');
    setImmediate(() => fs.writeSync(1, 'next turn\\n'));
  `);
  assert.deepStrictEqual(check(result), ['same turn', 'a', 'b', 'next turn']);
});

test('records are written once enough are buffered', () => {
  const result = runScript(`
    const fs = require('node:fs');
    const log = logger.create(new logger.ConsoleProvider());
    const pad = 'x'.repeat(1024);
    for (let i = 0; i < 100; i++) log.info(String(i), { pad });
    fs.writeSync(1, 'marker\\n');
  `);
  const output = check(result);
  const marker = output.indexOf('marker');
  assert.ok(marker > 0 && marker < 100, `marker at ${marker}`);
  assert.deepStrictEqual(output.filter((m) => m !== 'marker'),
                         Array.from({ length: 100 }, (_, i) => String(i)));
});

test('records are written immediately with sync', () => {
  const result = runScript(`
    const fs = require('node:fs');
    const log = logger.create(new logger.ConsoleProvider({ sync: true }));
    log.info('a');
    fs.writeSync(1, 'marker\\n');
    log.info('b');
  `);
  assert.deepStrictEqual(check(result), ['a', 'marker', 'b']);
});

test('flushSync() and flush() write buffered records', () => {
  const result = runScript(`
    const assert = require('node:assert');
    const fs = require('node:fs');
    const provider = new logger.ConsoleProvider();
    const log = logger.create(provider);
    log.info('a');
    provider.flushSync();
    fs.writeSync(1, 'flushSync\\n');
    log.info('b');
    let called = false;
    provider.flush((err) => {
      assert.strictEqual(err, null);
      called = true;
      fs.writeSync(1, 'flush callback\\n');
    });
    assert.strictEqual(called, false);
    fs.writeSync(1, 'flush returned\\n');
    assert.throws(() => provider.flush('nope'), { code: 'ERR_INVALID_ARG_TYPE' });
  `);
  assert.deepStrictEqual(check(result),
                         ['a', 'flushSync', 'b', 'flush returned', 'flush callback']);
});

test('records wait for minLength, then periodicFlush or exit', () => {
  const result = runScript(`
    const fs = require('node:fs');
    const minLength = logger.create(new logger.ConsoleProvider({ minLength: 4096 }));
    const periodic = logger.create(new logger.ConsoleProvider({
      minLength: 4096,
      periodicFlush: 10,
    }));
    minLength.info('at exit');
    periodic.info('periodic');
    setTimeout(() => fs.writeSync(1, 'marker\\n'), 200);
  `);
  assert.deepStrictEqual(check(result), ['periodic', 'marker', 'at exit']);
});

test('records are flushed before maxLength would drop them', () => {
  const result = runScript(`
    const provider = new logger.ConsoleProvider({ maxLength: 200 });
    const log = logger.create(provider);
    const dropped = [];
    provider.stream.on('drop', (data) => dropped.push(JSON.parse(data).message));
    for (let i = 0; i < 10; i++) log.info(String(i));
    log.info('too large', { pad: 'x'.repeat(300) });
    process.on('exit', () => console.log(dropped.join()));
  `);
  assert.deepStrictEqual(check(result), [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'too large',
  ]);
});

test('pending records are written on process.exit()', () => {
  const result = runScript(`
    const log = logger.create();
    for (let i = 0; i < 10000; i++) log.info(String(i));
    process.exit(0);
  `);
  const output = check(result);
  assert.strictEqual(output.length, 10000);
  assert.strictEqual(output[9999], '9999');
});

test('records logged by exit listeners are written', () => {
  const result = runScript(`
    let log;
    process.on('exit', () => log.info('listener added before'));
    log = logger.create();
    process.on('exit', () => log.info('listener added after'));
    log.info('a');
  `);
  assert.deepStrictEqual(check(result),
                         ['a', 'listener added before', 'listener added after']);
});

test('pending records are written on process.exit() in a worker', () => {
  const result = runScript(`
    const { Worker } = require('node:worker_threads');
    new Worker(\`
      const log = require(\${JSON.stringify(${JSON.stringify(loggerPath)})}).create();
      for (let i = 0; i < 10000; i++) log.info(String(i));
      process.exit(0);
    \`, { eval: true });
  `);
  assert.strictEqual(check(result).length, 10000);
});

// On Windows, libuv does not close fds 0-2, so writes to stdout keep working.
test('write errors are emitted on the stream', {
  skip: process.platform === 'win32' && 'stdout cannot be closed',
}, () => {
  const result = runScript(`
    const assert = require('node:assert');
    const fs = require('node:fs');
    const provider = new logger.ConsoleProvider();
    const log = logger.create(provider);
    let sync = true;
    provider.stream.on('error', (err) => {
      assert.strictEqual(sync, false);
      fs.writeSync(2, err.code);
    });
    fs.closeSync(1);
    log.info('a');
    provider.flush();
    sync = false;
  `);
  assert.strictEqual(result.stderr, 'EBADF');
  assert.strictEqual(result.status, 0);
});

// Through a shell pipe, which (unlike the socket pairs created by
// child_process) the main thread makes non-blocking when it creates a Worker,
// so writes from different threads are frequently split and interleaved
// without the stdio lock. With `preload`, the main thread loads the module
// before running `script`.
const piped = {
  skip: process.platform === 'win32' && 'requires a POSIX shell',
};

function runPiped(t, script, { preload = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodejs-logger-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'script.js');
  const prefix = preload ? `require(${JSON.stringify(loggerPath)});\n` : '';
  fs.writeFileSync(file, `const loggerPath = ${JSON.stringify(loggerPath)};\n` +
                         prefix + script);
  return spawnSync('/bin/sh', ['-c', '"$0" "$1" | cat', process.execPath, file],
                   { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// Source of a worker that logs `count` large records, in bursts over several
// turns of the event loop.
function loggingWorker(count, options = '{}') {
  return `
    const { ConsoleProvider, create } = require(loggerPath);
    const log = create(new ConsoleProvider(${options}));
    const pad = 'x'.repeat(8 * 1024);
    let i = 0;
    (function burst() {
      for (let j = 0; j < 50 && i < ${count}; j++, i++) log.info('record', { pad });
      if (i < ${count}) setImmediate(burst);
    })();
  `;
}

function checkRecords(result, count) {
  const output = check(result);
  assert.strictEqual(output.length, count);
  assert.ok(output.every((m) => m === 'record'));
}

for (const preload of [true, false]) {
  for (const sync of [false, true]) {
    const name = `records from workers do not interleave (preload: ${preload}, ` +
      `sync: ${sync})`;
    test(name, piped, (t) => {
      const result = runPiped(t, `
        const { Worker } = require('node:worker_threads');
        for (let i = 0; i < 4; i++) {
          new Worker(\`const loggerPath = \${JSON.stringify(loggerPath)};
            ${loggingWorker(1000, `{ sync: ${sync} }`)}\`, { eval: true });
        }
      `, { preload });
      checkRecords(result, 4000);
    });
  }
}

test('workers created before loading forward records', piped, (t) => {
  // The workers, and the nested workers they create, do not share the stdio
  // lock. The main thread loads the module after creating them, and logs
  // while they forward their records to it.
  const result = runPiped(t, `
    const { Worker } = require('node:worker_threads');
    const source = \`const loggerPath = \${JSON.stringify(loggerPath)};
      const { Worker, workerData } = require('node:worker_threads');
      const { hasSharedStdioLock } = require(${JSON.stringify(stdioLockPath)});
      if (hasSharedStdioLock) throw new Error('the worker shares the lock');
      if (workerData !== 'nested') {
        new Worker(__source, { eval: true, workerData: 'nested' });
      }
      ${loggingWorker(2000)}\`;
    for (let i = 0; i < 2; i++) {
      new Worker('const __source = ' + JSON.stringify(source) + ';' + source,
                 { eval: true });
    }
    eval(${JSON.stringify(loggingWorker(2000))});
  `, { preload: false });
  checkRecords(result, 10000);
});

test('forwarded records are written on process.exit()', piped, (t) => {
  const result = runPiped(t, `
    const { Worker } = require('node:worker_threads');
    new Worker(\`
      const log = require(\${JSON.stringify(loggerPath)}).create();
      for (let i = 0; i < 10000; i++) log.info(String(i));
      process.exit(0);
    \`, { eval: true });
  `, { preload: false });
  assert.strictEqual(check(result).length, 10000);
});

test('the stdio lock is reentrant', () => {
  const { acquireStdioLock, releaseStdioLock } = require(stdioLockPath);
  acquireStdioLock();
  acquireStdioLock();
  releaseStdioLock();
  releaseStdioLock();
  acquireStdioLock();
  releaseStdioLock();
});

test('the stdio lock is shared with workers', async () => {
  const { acquireStdioLock, releaseStdioLock } = require(stdioLockPath);
  acquireStdioLock();
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { acquireStdioLock, releaseStdioLock } = require(${JSON.stringify(stdioLockPath)});
    parentPort.postMessage('started');
    acquireStdioLock();
    parentPort.postMessage('acquired');
    releaseStdioLock();
  `, { eval: true });
  const messagesReceived = [];
  const done = new Promise((resolve) => {
    worker.on('message', (message) => {
      messagesReceived.push(message);
      if (message === 'started') {
        setTimeout(() => {
          messagesReceived.push('released');
          releaseStdioLock();
        }, 100);
      }
    });
    worker.on('exit', resolve);
  });
  await done;
  assert.deepStrictEqual(messagesReceived, ['started', 'released', 'acquired']);
});

test('a lock held by a terminated worker is taken over', async () => {
  const { acquireStdioLock, kMaxWaitMs, releaseStdioLock } =
    require(stdioLockPath);
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { acquireStdioLock } = require(${JSON.stringify(stdioLockPath)});
    acquireStdioLock();
    parentPort.postMessage('acquired');
    for (;;);
  `, { eval: true });
  await new Promise((resolve) => worker.once('message', resolve));
  await worker.terminate();
  const start = Date.now();
  acquireStdioLock();
  const waited = Date.now() - start;
  releaseStdioLock();
  assert.ok(waited >= kMaxWaitMs - 50 && waited < kMaxWaitMs * 2,
            `waited ${waited} ms`);
});
