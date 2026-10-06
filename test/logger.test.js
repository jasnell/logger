'use strict';

const assert = require('node:assert');
const { AsyncLocalStorage } = require('node:async_hooks');
const EventEmitter = require('node:events');
const { test } = require('node:test');
const { mustCall, mustNotCall } = require('./common');
const loggerModule = require('..');
const {
  AggregateProvider,
  ConsoleProvider,
  EventProvider,
  Logger,
  create,
  getDefaultProvider,
  levels,
  setDefaultProvider,
} = loggerModule;

// Bindings, attributes, levels, and contexts do not inherit from
// Object.prototype. Their prototype is an empty, frozen object whose own
// prototype is null.
function assertNullPrototypeEqual(actual, expected) {
  const proto = Object.getPrototypeOf(actual);
  assert.strictEqual(Object.getPrototypeOf(proto), null);
  assert.deepStrictEqual(Reflect.ownKeys(proto), []);
  assert.strictEqual(Object.isFrozen(proto), true);
  assert.deepStrictEqual(actual, { __proto__: proto, ...expected });
}

test('module exports create() with properties', () => {
  assert.strictEqual(typeof loggerModule, 'function');
  assert.strictEqual(loggerModule, create);
  for (const name of ['AggregateProvider', 'ConsoleProvider',
                      'DiagnosticsProvider', 'EventProvider', 'Logger',
                      'create', 'getDefaultProvider', 'levels',
                      'setDefaultProvider']) {
    assert.ok(Object.hasOwn(create, name), name);
    assert.ok(Object.getOwnPropertyDescriptor(create, name).enumerable);
  }
});

test('default provider is a lazily created ConsoleProvider', () => {
  const defaultProvider = getDefaultProvider();
  const first = loggerModule();
  const second = create();

  assert.strictEqual(Object.hasOwn(create, 'defaultProvider'), false);
  assert.strictEqual(getDefaultProvider(), defaultProvider);
  assert.ok(defaultProvider instanceof ConsoleProvider);
  assert.ok(first instanceof Logger);
  assert.strictEqual(first.provider, defaultProvider);
  assert.strictEqual(second.provider, defaultProvider);
});

test('setDefaultProvider() emits defaultLoggerProviderChanged', (t) => {
  const original = getDefaultProvider();
  const provider = new EventProvider();
  const reentrantProvider = new EventProvider();
  const events = [];
  const changes = [];
  const eventName = 'defaultLoggerProviderChanged';
  const listener = mustCall(t, (changedProvider, currentProvider) => {
    changes.push([changedProvider, currentProvider]);
    assert.throws(
      () => setDefaultProvider(reentrantProvider),
      { code: 'ERR_INVALID_STATE' },
    );
  }, 2);
  provider.on('log', mustCall(t, (event) => events.push(event)));

  process.on(eventName, listener);
  try {
    setDefaultProvider(provider);
    assert.deepStrictEqual(changes, [[provider, original]]);
    setDefaultProvider(provider);
    assert.deepStrictEqual(changes, [[provider, original]]);
    assert.throws(
      () => setDefaultProvider({}),
      { code: 'ERR_INVALID_ARG_TYPE' },
    );
    assert.deepStrictEqual(changes, [[provider, original]]);

    const logger = create({ name: 'custom-default' });
    assert.strictEqual(getDefaultProvider(), provider);
    assert.strictEqual(logger.provider, provider);
    assert.strictEqual(new Logger().provider, provider);
    logger.info('redirected');
    assert.strictEqual(events[0].message, 'redirected');
  } finally {
    setDefaultProvider(original);
    process.off(eventName, listener);
  }

  assert.deepStrictEqual(changes, [
    [provider, original],
    [original, provider],
  ]);
  assert.strictEqual(getDefaultProvider(), original);
});

test('defaultLoggerProviderChanged listeners can reject a change', (t) => {
  const original = getDefaultProvider();
  const provider = new EventProvider();
  const expected = new Error('default provider rejected');
  const eventName = 'defaultLoggerProviderChanged';
  const listener = mustCall(t, () => { throw expected; });

  process.once(eventName, listener);
  try {
    assert.throws(
      () => setDefaultProvider(provider),
      (error) => error === expected,
    );
    assert.strictEqual(getDefaultProvider(), original);

    setDefaultProvider(provider);
    assert.strictEqual(getDefaultProvider(), provider);
  } finally {
    process.off(eventName, listener);
    if (getDefaultProvider() !== original) {
      setDefaultProvider(original);
    }
  }
});

test('Logger methods and getters validate the receiver', () => {
  const invalidThis = {
    code: 'ERR_INVALID_THIS',
    message: 'Value of "this" must be of type Logger',
    name: 'TypeError',
  };
  const receivers = [null, undefined, { __proto__: Logger.prototype }];
  const getters = ['bindings', 'name', 'provider'];
  const methods = [
    'child',
    'debug',
    'error',
    'fatal',
    'info',
    'isEnabled',
    'log',
    'trace',
    'warn',
  ];

  for (const receiver of receivers) {
    for (const name of getters) {
      const getter =
        Object.getOwnPropertyDescriptor(Logger.prototype, name).get;
      assert.throws(() => Reflect.apply(getter, receiver, []), invalidThis);
    }
    for (const name of methods) {
      assert.throws(
        () => Reflect.apply(Logger.prototype[name], receiver, []),
        invalidThis,
      );
    }
  }
});

test('events, bindings, and child loggers', (t) => {
  const events = [];
  const contexts = [];
  const provider = {
    isEnabled(level, context) {
      contexts.push(context);
      return level.value >= levels.debug.value;
    },
    log: mustCall(t, function log(event) {
      assert.strictEqual(this, provider);
      events.push(event);
    }, 2),
  };
  const inputBindings = { service: 'api' };
  const logger = create(provider, {
    name: 'root',
    bindings: inputBindings,
  });

  inputBindings.service = 'changed';

  assert.strictEqual(logger.provider, provider);
  assert.strictEqual(logger.name, 'root');
  assertNullPrototypeEqual(logger.bindings, {
    service: 'api',
  });
  assert.strictEqual(Object.isFrozen(logger.bindings), true);
  assert.strictEqual(logger.isEnabled('trace'), false);
  assert.strictEqual(logger.isEnabled('debug'), true);

  logger.trace('filtered');

  const inputAttributes = { requestId: 1 };
  logger.info('request received', inputAttributes);
  inputAttributes.requestId = 2;

  assert.strictEqual(events.length, 1);
  const event = events[0];
  assert.strictEqual(event.message, 'request received');
  assert.strictEqual(event.name, 'root');
  assert.strictEqual(event.level, levels.info);
  assert.strictEqual(typeof event.timestamp, 'number');
  assertNullPrototypeEqual(event.bindings, {
    service: 'api',
  });
  assertNullPrototypeEqual(event.attributes, {
    requestId: 1,
  });
  // Per-event objects are not frozen. The bindings are shared by every
  // event from the logger, so they are.
  assert.strictEqual(Object.isFrozen(event), false);
  assert.strictEqual(Object.isFrozen(event.attributes), false);
  assert.strictEqual(event.bindings, logger.bindings);
  assert.strictEqual(Object.isFrozen(event.bindings), true);
  assert.strictEqual(contexts.at(-1).name, 'root');

  const child = logger.child({ service: 'worker', workerId: 2 });
  assert.strictEqual(child.provider, provider);
  assert.strictEqual(child.name, 'root');
  assertNullPrototypeEqual(child.bindings, {
    service: 'worker',
    workerId: 2,
  });

  child.log({ name: 'notice', value: 35 }, 'custom level');
  assert.strictEqual(events.length, 2);
  assertNullPrototypeEqual(events[1].level, {
    name: 'notice',
    value: 35,
  });
});

test('child() can rename the logger', (t) => {
  const events = [];
  const logger = create({ log(event) { events.push(event); } },
                        { name: 'parent' });
  const child = logger.child({}, { name: 'child' });
  assert.strictEqual(child.name, 'child');
  child.info('renamed');
  assert.strictEqual(events[0].name, 'child');
  assert.throws(() => logger.child({}, { name: 1 }),
                { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => logger.child(null), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('providers without isEnabled() receive every event', () => {
  const events = [];
  const provider = {
    log(event) {
      events.push(event);
    },
  };
  const logger = new Logger(provider);

  logger.fatal('fatal message');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(logger.isEnabled('trace'), true);
});

test('function bindings and attributes are resolved per event', (t) => {
  const bindingStorage = new AsyncLocalStorage();
  const attributeStorage = new AsyncLocalStorage();
  const request = mustCall(t, () => bindingStorage.getStore(), 3);
  const operation = mustCall(t, () => attributeStorage.getStore(), 2);
  const events = [];
  const logger = create({
    log(event) {
      events.push(event);
    },
  }, {
    bindings: { rawStorage: bindingStorage, request },
  });

  logger.info('outside', { operation, rawStorage: attributeStorage });
  bindingStorage.run({ requestId: 1 }, () => {
    attributeStorage.run('create', () => {
      logger.info('inside', { operation });
    });
  });
  bindingStorage.run({ requestId: 2 }, () => {
    logger.info('second request');
  });

  assert.strictEqual(logger.bindings.request, request);
  assert.strictEqual(events[0].bindings.rawStorage, bindingStorage);
  assert.strictEqual(events[0].bindings.request, undefined);
  assert.strictEqual(events[0].attributes.rawStorage, attributeStorage);
  assert.strictEqual(events[0].attributes.operation, undefined);
  assert.deepStrictEqual(events[1].bindings.request, { requestId: 1 });
  assert.strictEqual(events[1].attributes.operation, 'create');
  assert.deepStrictEqual(events[2].bindings.request, { requestId: 2 });
});

test('create() treats a non-provider first argument as options', () => {
  const logger = create({ name: 'options-only' });
  assert.strictEqual(logger.name, 'options-only');
  assert.ok(logger.provider instanceof ConsoleProvider);
});

test('EventProvider', (t) => {
  const provider = new EventProvider({ level: 'debug' });
  const logger = create(provider, { name: 'events' });
  const events = [];
  const warnings = [];

  assert.ok(provider instanceof EventEmitter);
  assert.strictEqual(provider.level, levels.debug);

  provider.on('log', mustCall(t, (event) => {
    events.push(event);
  }, 3));
  provider.on('warn', mustCall(t, (event) => {
    warnings.push(event);
  }));

  const message = { text: 'debug message' };
  logger.trace('filtered');
  logger.debug(message);
  logger.warn('warn message');
  logger.log({ name: 'notice', value: levels.warn.value }, 'notice message');
  logger.error('error message');

  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].level, levels.debug);
  assert.strictEqual(events[0].message, message);
  assert.strictEqual(events[1].level.name, 'notice');
  assert.strictEqual(events[1].level.value, levels.warn.value);
  assert.strictEqual(events[2].level, levels.error);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].level, levels.warn);

  provider.level = 'fatal';
  assert.strictEqual(provider.level, levels.fatal);
  assert.strictEqual(logger.isEnabled('error'), false);

  const customLevel = { name: 'notice', value: 35 };
  provider.level = customLevel;
  customLevel.value = 0;
  assert.strictEqual(provider.level.name, 'notice');
  assert.strictEqual(provider.level.value, 35);
  assert.strictEqual(Object.isFrozen(provider.level), true);

  assert.throws(() => new EventProvider(null),
                { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => new EventProvider({ level: 'nope' }),
                { code: 'ERR_INVALID_ARG_VALUE' });
});

test('AggregateProvider fans out to enabled providers', (t) => {
  const calls = [];
  let deliveredEvent;
  let loggerContext;
  const disabled = {
    isEnabled: mustCall(t, function isEnabled(level, context) {
      assert.strictEqual(level, levels.info);
      loggerContext ??= context;
      assert.strictEqual(context, loggerContext);
      return false;
    }, 2),
    log: mustNotCall(t),
  };
  const first = {
    isEnabled: mustCall(t, function isEnabled(level, context) {
      assert.strictEqual(level, levels.info);
      loggerContext ??= context;
      assert.strictEqual(context, loggerContext);
      return true;
    }, 2),
    log: mustCall(t, function log(event, context) {
      assert.strictEqual(this, first);
      assert.strictEqual(context, loggerContext);
      deliveredEvent = event;
      calls.push('first');
    }),
  };
  const second = {
    log: mustCall(t, function log(event, context) {
      assert.strictEqual(this, second);
      assert.strictEqual(context, loggerContext);
      assert.strictEqual(event, deliveredEvent);
      calls.push('second');
    }),
  };
  const input = [disabled, first, second];
  const provider = new AggregateProvider(input);
  const logger = create(provider, {
    name: 'aggregate',
    bindings: { service: 'api' },
  });

  input.length = 0;
  assert.strictEqual(Object.isFrozen(provider.providers), true);
  assert.deepStrictEqual(provider.providers, [disabled, first, second]);

  logger.info('fan out');

  assert.deepStrictEqual(calls, ['first', 'second']);
  assert.strictEqual(loggerContext.name, 'aggregate');
  assertNullPrototypeEqual(loggerContext.bindings, {
    service: 'api',
  });
});

test('empty AggregateProvider enables nothing', () => {
  const provider = new AggregateProvider([]);
  const logger = create(provider);

  assert.strictEqual(logger.isEnabled('fatal'), false);
  logger.fatal('discarded');
});

test('AggregateProvider propagates exceptions immediately', (t) => {
  const expected = new Error('provider failure');
  const provider = new AggregateProvider([
    { log() { throw expected; } },
    { log: mustNotCall(t) },
  ]);
  const logger = create(provider);

  assert.throws(() => logger.info('failed'), (error) => error === expected);
});

test('nested AggregateProvider', (t) => {
  const destination = { log: mustCall(t) };
  const provider = new AggregateProvider([
    new AggregateProvider([destination]),
  ]);

  create(provider).info('nested');
});

test('argument validation', () => {
  assert.throws(
    () => create(1),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => create({ log: 'not a function' }, {}),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => create({ log() {}, isEnabled: true }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => create({ bindings: [] }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => create({ name: 1 }),
    {
      code: 'ERR_INVALID_ARG_TYPE',
      message: 'The "options.name" property must be of type string. ' +
               'Received type number (1)',
    },
  );
  assert.throws(
    () => new AggregateProvider(),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new AggregateProvider([1]),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new AggregateProvider([{ log() {}, isEnabled: true }]),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );

  const logger = create({ log() {} });

  assert.throws(
    () => logger.info('message', []),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => logger.log('unknown', 'message'),
    {
      code: 'ERR_INVALID_ARG_VALUE',
      message: "The argument 'level' must be one of: 'trace', 'debug', " +
               "'info', 'warn', 'error', 'fatal'. Received 'unknown'",
    },
  );
  assert.throws(
    () => logger.log({ name: 'custom', value: 1.5 }, 'message'),
    {
      code: 'ERR_OUT_OF_RANGE',
      name: 'RangeError',
      message: 'The value of "level.value" is out of range. ' +
               'It must be an integer. Received 1.5',
    },
  );
  assert.throws(
    () => logger.log({ name: 1, value: 1 }, 'message'),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
});

test('built-in levels are frozen', () => {
  assert.strictEqual(Object.isFrozen(levels), true);
  assert.strictEqual(Object.getPrototypeOf(levels), null);
  assert.deepStrictEqual(Object.keys(levels),
                         ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  for (const name of Object.keys(levels)) {
    assert.strictEqual(Object.isFrozen(levels[name]), true);
    assert.strictEqual(levels[name].name, name);
  }
  assert.strictEqual(levels.info.value, 30);
});
