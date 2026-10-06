'use strict';

// Compares the cost of logging with pino. Both loggers produce flat JSON
// lines with a name and no pid or hostname, and their output is discarded
// without I/O, so only the work done by the logger itself is measured.

const common = require('./common.js');

const bench = common.createBenchmark(main, {
  logger: ['node-logger', 'pino'],
  scenario: [
    'disabled',
    'disabled-attributes',
    'message',
    'attributes',
    'error',
    'child-create',
    'child-log',
    'child-per-request',
  ],
});

const kIterations = {
  'disabled': 1e8,
  'disabled-attributes': 1e8,
  'message': 2e6,
  'attributes': 2e6,
  'error': 5e5,
  'child-create': 2e6,
  'child-log': 2e6,
  'child-per-request': 5e5,
};

function createNodeLogger() {
  const { ConsoleProvider, create } = require('..');
  const provider = new ConsoleProvider({ flatten: true });
  let bytes = 0;
  provider.stream.write = (data) => {
    bytes += data.length;
    return true;
  };
  const logger = create(provider, { name: 'bench' });
  return { logger, bytes: () => bytes };
}

function createPino() {
  const pino = require('pino');
  let bytes = 0;
  const destination = {
    write(data) {
      bytes += data.length;
      return true;
    },
  };
  const logger = pino({ base: null, name: 'bench' }, destination);
  return { logger, bytes: () => bytes };
}

// pino takes attributes first, node-logger takes the message first.
function makeLog(kind, logger, level) {
  if (kind === 'pino') {
    return (message, attributes) => {
      if (attributes === undefined) logger[level](message);
      else logger[level](attributes, message);
    };
  }
  return (message, attributes) => logger[level](message, attributes);
}

function main({ logger: kind, scenario }) {
  const n = common.smoke ? 10 : kIterations[scenario];
  const { logger, bytes } = kind === 'pino' ? createPino() : createNodeLogger();
  const err = new Error('boom');
  err.code = 'E_BOOM';
  const children = new Array(1024);

  switch (scenario) {
    case 'disabled': {
      bench.start();
      for (let i = 0; i < n; i++) logger.debug('hello');
      bench.end(n);
      break;
    }
    case 'disabled-attributes': {
      if (kind === 'pino') {
        bench.start();
        for (let i = 0; i < n; i++) logger.debug({ i }, 'hello');
        bench.end(n);
      } else {
        bench.start();
        for (let i = 0; i < n; i++) logger.debug('hello', { i });
        bench.end(n);
      }
      break;
    }
    case 'message': {
      bench.start();
      for (let i = 0; i < n; i++) logger.info('hello');
      bench.end(n);
      break;
    }
    case 'attributes': {
      const log = makeLog(kind, logger, 'info');
      bench.start();
      for (let i = 0; i < n; i++) log('hello', { i, user: 'x' });
      bench.end(n);
      break;
    }
    case 'error': {
      const log = makeLog(kind, logger, 'error');
      bench.start();
      for (let i = 0; i < n; i++) log('failed', { err });
      bench.end(n);
      break;
    }
    case 'child-create': {
      bench.start();
      for (let i = 0; i < n; i++) {
        children[i & 1023] = logger.child({ requestId: i });
      }
      bench.end(n);
      break;
    }
    case 'child-log': {
      const log = makeLog(kind, logger.child({ requestId: 1 }), 'info');
      bench.start();
      for (let i = 0; i < n; i++) log('handled', { step: i });
      bench.end(n);
      break;
    }
    case 'child-per-request': {
      bench.start();
      for (let i = 0; i < n; i++) {
        const log = makeLog(kind, logger.child({ requestId: i }), 'info');
        for (let j = 0; j < 3; j++) log('handled', { step: j });
      }
      bench.end(n);
      break;
    }
  }

  if (!scenario.startsWith('disabled') && scenario !== 'child-create' &&
      bytes() === 0) {
    throw new Error('nothing was serialized');
  }
}
