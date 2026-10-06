'use strict';

// Every enabled event is traced through the `nodejs:logger:log` tracing
// channel, regardless of the provider, as long as it has subscribers.

const assert = require('node:assert');
const { AsyncLocalStorage } = require('node:async_hooks');
const { tracingChannel } = require('node:diagnostics_channel');
const { test } = require('node:test');
const { mustCall, mustNotCall } = require('./common');
const {
  ConsoleProvider,
  EventProvider,
  create,
  levels,
} = require('..');

const logChannel = tracingChannel('nodejs:logger:log');

function subscribe(t, handlers) {
  logChannel.subscribe(handlers);
  t.after(() => logChannel.unsubscribe(handlers));
}

test('start and end receive the event and context', (t) => {
  const order = [];
  let delivered;
  let deliveredContext;
  const provider = {
    log: mustCall(t, (event, context) => {
      order.push('log');
      delivered = event;
      deliveredContext = context;
    }),
  };
  const logger = create(provider, { name: 'traced', bindings: { a: 1 } });

  subscribe(t, {
    start: mustCall(t, (message) => {
      order.push('start');
      assert.strictEqual(message.event.message, 'hello');
      assert.strictEqual(message.event.level, levels.info);
      assert.strictEqual(message.context.name, 'traced');
      assert.strictEqual(message.context.bindings.a, 1);
    }),
    end: mustCall(t, (message) => {
      order.push('end');
      assert.strictEqual(message.event, delivered);
      assert.strictEqual(message.context, deliveredContext);
    }),
    error: mustNotCall(t),
  });

  logger.info('hello', { b: 2 });
  assert.deepStrictEqual(order, ['start', 'log', 'end']);
});

test('start can modify the event and end can restore it', (t) => {
  const events = [];
  const provider = new EventProvider();
  provider.on('log', (event) => {
    events.push({
      bindings: { ...event.bindings },
      attributes: { ...event.attributes },
    });
  });
  const logger = create(provider, { bindings: { service: 'api' } });

  const saved = new WeakMap();
  subscribe(t, {
    start(message) {
      const { event } = message;
      // Attributes are a new, mutable object for every traced event, even
      // when none were passed.
      event.attributes.traceId = 'abc';
      // Bindings are shared and frozen, so they are replaced.
      saved.set(message, event.bindings);
      event.bindings = { ...event.bindings, spanId: 1 };
    },
    end(message) {
      delete message.event.attributes.traceId;
      message.event.bindings = saved.get(message);
    },
  });

  logger.info('no attributes');
  logger.info('with attributes', { user: 'x' });

  assert.deepStrictEqual(events, [
    { bindings: { service: 'api', spanId: 1 }, attributes: { traceId: 'abc' } },
    {
      bindings: { service: 'api', spanId: 1 },
      attributes: { user: 'x', traceId: 'abc' },
    },
  ]);
});

test('injected values reach ConsoleProvider output', (t) => {
  const provider = new ConsoleProvider({ flatten: true });
  const lines = [];
  provider.stream.write = (data) => {
    lines.push(JSON.parse(data));
    return true;
  };
  const logger = create(provider, { bindings: { service: 'api' } });

  subscribe(t, {
    start({ event }) {
      event.attributes.traceId = 'abc';
      event.bindings = { ...event.bindings, spanId: 1 };
    },
  });

  logger.info('first');
  logger.info('second', { user: 'x' });
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(
    [lines[0].service, lines[0].spanId, lines[0].traceId],
    ['api', 1, 'abc']);
  assert.deepStrictEqual(
    [lines[1].service, lines[1].spanId, lines[1].traceId, lines[1].user],
    ['api', 1, 'abc', 'x']);
});

test('provider errors are published to the error channel', (t) => {
  const expected = new Error('provider failure');
  const logger = create({ log() { throw expected; } });

  const order = [];
  subscribe(t, {
    start: mustCall(t, () => order.push('start')),
    error: mustCall(t, (message) => {
      order.push('error');
      assert.strictEqual(message.error, expected);
    }),
    // end is always published, so that subscribers can restore the event.
    end: mustCall(t, (message) => {
      order.push('end');
      assert.strictEqual(message.error, expected);
    }),
  });

  assert.throws(() => logger.error('fails'), (error) => error === expected);
  assert.deepStrictEqual(order, ['start', 'error', 'end']);
});

test('disabled events are not published', (t) => {
  const logger = create(new EventProvider({ level: 'warn' }));
  const custom = create({ isEnabled: () => false, log: mustNotCall(t) });
  subscribe(t, { start: mustNotCall(t) });
  logger.info('disabled');
  custom.error('disabled');
});

test('stores bound to start are active in the provider', (t) => {
  const store = new AsyncLocalStorage();
  const provider = {
    log: mustCall(t, () => {
      assert.strictEqual(store.getStore(), 'bound');
    }),
  };
  const logger = create(provider);
  logChannel.start.bindStore(store, () => 'bound');
  t.after(() => logChannel.start.unbindStore(store));

  logger.info('with store');
  assert.strictEqual(store.getStore(), undefined);
});

test('events are not traced without subscribers', (t) => {
  const events = [];
  const logger = create({ log(event) { events.push(event); } });
  logger.info('untraced');
  // Without subscribers, the shared, frozen empty attributes are passed.
  assert.strictEqual(Object.isFrozen(events[0].attributes), true);

  subscribe(t, { end() {} });
  logger.info('traced');
  assert.strictEqual(Object.isFrozen(events[1].attributes), false);
});
