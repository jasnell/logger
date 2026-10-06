'use strict';

// Tests that level methods for disabled levels are resolved to an empty
// function ahead of time for providers whose enablement changes are
// observable, and that they are re-resolved when the enablement changes.

const assert = require('node:assert');
const { setImmediate: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { setFlagsFromString } = require('node:v8');
const { runInNewContext } = require('node:vm');
const { mustCall } = require('./common');
const {
  AggregateProvider,
  ConsoleProvider,
  EventProvider,
  Logger,
  create,
} = require('..');

const levelNames = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function isReal(logger, name) {
  return logger[name] === Logger.prototype[name];
}

function assertEnabled(logger, expected) {
  for (const name of levelNames) {
    assert.strictEqual(isReal(logger, name), expected.includes(name),
                       `unexpected method for ${name}`);
  }
}

test('disabled levels share a single empty function', () => {
  const logger = create(new EventProvider({ level: 'warn' }));
  assertEnabled(logger, ['warn', 'error', 'fatal']);
  assert.strictEqual(logger.trace, logger.debug);
  assert.strictEqual(logger.trace, logger.info);
  assert.strictEqual(logger.trace.length, 0);
  for (const name of levelNames) {
    assert.strictEqual(Object.hasOwn(logger, name), false);
  }
  assert.ok(logger instanceof Logger);
  assert.strictEqual(logger.constructor, Logger);
});

test('level changes re-resolve existing loggers and children', () => {
  for (const Provider of [ConsoleProvider, EventProvider]) {
    const provider = new Provider({ level: 'info' });
    const logger = create(provider);
    const child = logger.child({ a: 1 });
    assertEnabled(logger, ['info', 'warn', 'error', 'fatal']);
    assertEnabled(child, ['info', 'warn', 'error', 'fatal']);

    provider.level = 'trace';
    assertEnabled(logger, levelNames);
    assertEnabled(child, levelNames);

    provider.level = { name: 'custom', value: 55 };
    assertEnabled(logger, ['fatal']);
    assertEnabled(child, ['fatal']);

    // Loggers created after the change see the new level.
    assertEnabled(create(provider), ['fatal']);
  }
});

test('events are delivered only once the level is enabled', (t) => {
  const provider = new EventProvider({ level: 'error' });
  const logger = create(provider);
  provider.on('log', mustCall(t, 1));
  logger.warn('discarded');
  provider.level = 'warn';
  logger.warn('delivered');
});

test('loggers with different providers do not share resolutions', () => {
  const a = create(new EventProvider({ level: 'trace' }));
  const b = create(new EventProvider({ level: 'fatal' }));
  assertEnabled(a, levelNames);
  assertEnabled(b, ['fatal']);
  assert.notStrictEqual(Object.getPrototypeOf(a), Object.getPrototypeOf(b));
  // Loggers with the same provider share the dispatch prototype.
  assert.strictEqual(Object.getPrototypeOf(b),
                     Object.getPrototypeOf(b.child({})));
});

test('aggregate providers enable the union of their members', () => {
  const first = new EventProvider({ level: 'error' });
  const second = new ConsoleProvider({ level: 'fatal' });
  const aggregate = new AggregateProvider([first, second, first]);
  const logger = create(aggregate);
  const nested = create(new AggregateProvider([aggregate]));
  assertEnabled(logger, ['error', 'fatal']);
  assertEnabled(nested, ['error', 'fatal']);

  second.level = 'debug';
  assertEnabled(logger, ['debug', 'info', 'warn', 'error', 'fatal']);
  assertEnabled(nested, ['debug', 'info', 'warn', 'error', 'fatal']);

  first.level = 'trace';
  assertEnabled(logger, levelNames);
  assertEnabled(nested, levelNames);
});

test('aggregate members without isEnabled() are always enabled', () => {
  const provider = new EventProvider({ level: 'fatal' });
  const logger = create(new AggregateProvider([provider, { log() {} }]));
  assertEnabled(logger, levelNames);
});

test('collected aggregates do not break member level changes', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const provider = new EventProvider({ level: 'fatal' });
  (() => create(new AggregateProvider([provider])))();
  gc();
  await sleep();
  provider.level = 'trace';
  assertEnabled(create(provider), levelNames);
});

test('unobservable providers are checked on every call', (t) => {
  let enabled = false;
  const provider = {
    isEnabled: mustCall(t, () => enabled, 2),
    log: mustCall(t),
  };
  const logger = create(provider);
  assertEnabled(logger, levelNames);
  assert.strictEqual(Object.getPrototypeOf(logger), Logger.prototype);
  logger.info('discarded');
  enabled = true;
  logger.info('delivered');
});

test('overriding isEnabled() on a built-in provider opts out', () => {
  class Custom extends EventProvider {
    isEnabled(level) { return level.value >= 50; }
  }
  const logger = create(new Custom({ level: 'trace' }));
  assertEnabled(logger, levelNames);
  assert.strictEqual(Object.getPrototypeOf(logger), Logger.prototype);

  const aggregate = create(new AggregateProvider([
    new EventProvider({ level: 'fatal' }),
    new Custom(),
  ]));
  assertEnabled(aggregate, levelNames);
});

test('Logger subclasses keep their own methods', () => {
  class MyLogger extends Logger {
    debug(message) { return `custom ${message}`; }
    extra() { return 'extra'; }
  }
  const provider = new EventProvider({ level: 'fatal' });
  const logger = new MyLogger(provider);
  assert.ok(logger instanceof MyLogger);
  assert.strictEqual(logger.extra(), 'extra');
  assert.strictEqual(logger.debug('x'), 'custom x');
  assert.notStrictEqual(logger.trace, Logger.prototype.trace);
  assert.strictEqual(logger.trace, create(provider).trace);

  provider.level = 'trace';
  assert.strictEqual(logger.debug('x'), 'custom x');
  assert.strictEqual(logger.trace, Logger.prototype.trace);

  // Plain loggers with the same provider are unaffected by the subclass.
  assertEnabled(create(provider), levelNames);
});

test('create(), child(), new Logger() share dispatch prototype', () => {
  const provider = new EventProvider({ level: 'warn' });
  const fromCreate = create(provider);
  const dispatch = Object.getPrototypeOf(fromCreate);
  assert.notStrictEqual(dispatch, Logger.prototype);
  assert.strictEqual(Object.getPrototypeOf(dispatch), Logger.prototype);
  assert.strictEqual(Object.getPrototypeOf(new Logger(provider)),
                     dispatch);
  assert.strictEqual(Object.getPrototypeOf(fromCreate.child({ a: 1 })),
                     dispatch);
  assert.strictEqual(
    Object.getPrototypeOf(create(provider, { name: 'x' })), dispatch);
  assert.strictEqual(fromCreate.constructor, Logger);

  // The default provider, whether omitted or replaced by options.
  const defaultDispatch = Object.getPrototypeOf(new Logger());
  assert.notStrictEqual(defaultDispatch, Logger.prototype);
  assert.strictEqual(Object.getPrototypeOf(create()), defaultDispatch);
  assert.strictEqual(Object.getPrototypeOf(create({ name: 'x' })),
                     defaultDispatch);
  assert.strictEqual(Object.getPrototypeOf(create(null, { name: 'x' })),
                     defaultDispatch);
});

test('create() reports invalid arguments like the constructor', () => {
  for (const args of [
    [{ log() {}, isEnabled: true }],
    [{ notAProvider: true }, {}],
    [new EventProvider(), 'not options'],
    [new EventProvider(), { name: 1 }],
  ]) {
    let expected;
    try {
      new Logger(...args);
    } catch (err) {
      expected = err;
    }
    assert.ok(expected);
    assert.throws(() => create(...args), {
      name: expected.name,
      code: expected.code,
      message: expected.message,
    });
  }
});

test('a dispatch prototype is only used for its own provider', () => {
  const quiet = new EventProvider({ level: 'fatal' });
  const loud = new EventProvider({ level: 'trace' });
  const quietDispatch = Object.getPrototypeOf(create(quiet));
  function Crafted() {}
  Crafted.prototype = quietDispatch;
  const logger = Reflect.construct(Logger, [loud], Crafted);
  assertEnabled(logger, levelNames);
  assert.strictEqual(Object.getPrototypeOf(logger),
                     Object.getPrototypeOf(create(loud)));

  // Also when the other provider is not dispatchable.
  const custom = { isEnabled: () => true, log() {} };
  const plain = Reflect.construct(Logger, [custom], Crafted);
  assert.strictEqual(Object.getPrototypeOf(plain), Logger.prototype);
  assertEnabled(plain, levelNames);
});

test('children get the plain dispatch prototype', () => {
  class MyLogger extends Logger {}
  const provider = new EventProvider({ level: 'error' });
  const dispatch = Object.getPrototypeOf(create(provider));
  const parents = [create(provider), new Logger(provider),
                   new MyLogger(provider)];
  for (const parent of parents) {
    const child = parent.child({ a: 1 });
    const grandchild = child.child({ b: 2 });
    assert.strictEqual(Object.getPrototypeOf(child), dispatch);
    assert.strictEqual(Object.getPrototypeOf(grandchild), dispatch);
    assert.strictEqual(child instanceof MyLogger, false);
    assertEnabled(grandchild, ['error', 'fatal']);
  }
  provider.level = 'trace';
  assertEnabled(parents[2].child({}).child({}), levelNames);

  // Not dispatchable: children keep the plain prototype.
  const custom = create({ isEnabled: () => true, log() {} });
  assert.strictEqual(Object.getPrototypeOf(custom.child({}).child({})),
                     Logger.prototype);
});

test('function bindings are resolved for children', () => {
  const events = [];
  const parent = create({ log(event) { events.push(event); } }, {
    bindings: { dynamic: () => 'resolved', fixed: 1 },
  });
  parent.child({ extra: 2 }).info('inherited');
  parent.child({ dynamic: 'value' }).info('overridden');
  parent.child({}).child({ more: () => 3 }).info('grandchild');
  assert.strictEqual(events[0].bindings.dynamic, 'resolved');
  assert.strictEqual(events[0].bindings.extra, 2);
  assert.strictEqual(events[1].bindings.dynamic, 'value');
  assert.strictEqual(events[2].bindings.dynamic, 'resolved');
  assert.strictEqual(events[2].bindings.more, 3);
});

test('child bindings are only ever observed frozen', (t) => {
  const provider = {
    isEnabled: mustCall(t, (level, context) => {
      assert.ok(Object.isFrozen(context.bindings));
      return true;
    }, 2),
    log: mustCall(t, (event, context) => {
      assert.ok(Object.isFrozen(event.bindings));
      assert.ok(Object.isFrozen(context.bindings));
    }, 2),
  };
  const parent = create(provider, { bindings: { a: 1 } });
  const child = parent.child({ b: 2 });
  assert.ok(Object.isFrozen(parent.child({ c: 3 }).bindings));
  child.child({ d: 4 }).info('grandchild first');
  child.info('child');
});
