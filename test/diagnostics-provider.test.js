'use strict';

const assert = require('node:assert');
const { channel } = require('node:diagnostics_channel');
const { test } = require('node:test');
const { mustCall } = require('./common');
const { DiagnosticsProvider, create, levels } = require('..');

test('channel mapping', (t) => {
  const allChannel = channel('test:logger:diagnostics:all');
  const errorChannel = channel('test:logger:diagnostics:error');
  const allEvents = [];
  const errorEvents = [];
  const onAll = mustCall(t, (event) => allEvents.push(event), 2);
  const onError = mustCall(t, (event) => errorEvents.push(event));
  const provider = new DiagnosticsProvider({
    'test:logger:diagnostics:all':
      (level) => level.value >= levels.info.value,
    'test:logger:diagnostics:error':
      (level) => level.name === 'error',
  });
  const logger = create(provider);

  assert.strictEqual(logger.isEnabled('info'), false);
  allChannel.subscribe(onAll);
  errorChannel.subscribe(onError);
  try {
    logger.debug('filtered');
    logger.info('info message');
    logger.error('error message');
  } finally {
    allChannel.unsubscribe(onAll);
    errorChannel.unsubscribe(onError);
  }

  assert.strictEqual(allEvents[0].level, levels.info);
  assert.strictEqual(allEvents[1].level, levels.error);
  assert.strictEqual(errorEvents[0], allEvents[1]);
});

test('symbol channel names', (t) => {
  const name = Symbol('test:logger:diagnostics:symbol');
  const target = channel(name);
  const onEvent = mustCall(t);
  const logger = create(new DiagnosticsProvider({ [name]: () => true }));
  target.subscribe(onEvent);
  try {
    logger.info('symbol');
  } finally {
    target.unsubscribe(onEvent);
  }
});

test('routing function', (t) => {
  const name = 'test:logger:diagnostics:router';
  const target = channel(name);
  const events = [];
  const selectedLevels = [];
  const onEvent = mustCall(t, (event) => events.push(event));
  const provider = new DiagnosticsProvider((level) => {
    selectedLevels.push(level.name);
    return level.name === 'warn' ? name : undefined;
  });
  const logger = create(provider);

  target.subscribe(onEvent);
  try {
    logger.info('not routed');
    logger.warn('routed');
  } finally {
    target.unsubscribe(onEvent);
  }

  assert.deepStrictEqual(selectedLevels, ['info', 'warn', 'warn']);
  assert.strictEqual(events[0].level, levels.warn);
});

test('validation', () => {
  assert.strictEqual(
    new DiagnosticsProvider({}).isEnabled(levels.fatal), false);
  assert.throws(
    () => new DiagnosticsProvider(),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new DiagnosticsProvider({ channel: true }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  assert.throws(
    () => new DiagnosticsProvider(() => 1).isEnabled(levels.info),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
});
