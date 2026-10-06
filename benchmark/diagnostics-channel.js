'use strict';

// Cost of tracing enabled events through the `nodejs:logger:log` tracing
// channel, with a provider that does no work.

const common = require('./common.js');

const bench = common.createBenchmark(main, {
  n: [1e6],
  subscribers: ['none', 'start', 'start-end'],
});

function main({ n, subscribers }) {
  const { create } = require('..');
  const { tracingChannel } = require('node:diagnostics_channel');

  let last;
  const logger = create({ log(event) { last = event; } }, {
    name: 'bench',
    bindings: { service: 'api' },
  });

  const channel = tracingChannel('nodejs:logger:log');
  if (subscribers === 'start') {
    channel.start.subscribe((message) => {
      message.event.attributes.traceId = 'abc';
    });
  } else if (subscribers === 'start-end') {
    channel.subscribe({
      start(message) { message.event.attributes.traceId = 'abc'; },
      end(message) { delete message.event.attributes.traceId; },
      asyncStart() {},
      asyncEnd() {},
      error() {},
    });
  }

  bench.start();
  for (let i = 0; i < n; i++) logger.info('hello', { i });
  bench.end(n);

  if (last === undefined) throw new Error('no event was logged');
}
