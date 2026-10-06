# @nodejs/logger

A structured logging facade for Node.js with pluggable providers.

A logger composes structured log events and passes them to a provider.
Providers decide what to do with them: filtering, encoding, buffering, and
output. Libraries can log through a logger without deciding where their logs
go, and applications choose the provider.

> [!WARNING]
> This module is under active development. Until 1.0.0, breaking changes may
> happen in minor releases.

## Installation

```sh
npm install @nodejs/logger
```

Node.js 24.6.0 or later is required.

## Usage

```cjs
const create = require('@nodejs/logger');

const logger = create({ name: 'app' });
logger.info('server started', { port: 3000 });
// {"attributes":{"port":3000},"bindings":{},"level":{"name":"info","value":30},
//  "message":"server started","name":"app","timestamp":1791280457128}
```

```mjs
import create, { ConsoleProvider } from '@nodejs/logger';

const logger = create(new ConsoleProvider({ flatten: true, pid: true }), {
  name: 'app',
  bindings: { service: 'users' },
});
logger.info('server started', { port: 3000 });
// {"service":"users","port":3000,"level":30,"levelName":"info",
//  "message":"server started","name":"app","timestamp":1791280457128,"pid":4242}
```

### Child loggers and dynamic bindings

```js
const { AsyncLocalStorage } = require('node:async_hooks');
const create = require('@nodejs/logger');

const requestContext = new AsyncLocalStorage();
const logger = create({
  name: 'http',
  // Function values are invoked for every event.
  bindings: { request: () => requestContext.getStore() },
});

const child = logger.child({ component: 'router' });
requestContext.run({ requestId: 1 }, () => {
  child.info('handled', { statusCode: 200 });
});
```

### Default provider

Loggers created without a provider use the default provider, a
`ConsoleProvider` writing to stdout unless the application sets another one.
The default provider is shared by every copy of `@nodejs/logger` in the
process, so libraries can simply create loggers and let the application decide
where their logs go:

```js
// In a library:
const log = require('@nodejs/logger')({ name: 'my-library' });

// In the application:
const { setDefaultProvider, ConsoleProvider } = require('@nodejs/logger');
setDefaultProvider(new ConsoleProvider({ level: 'debug', destination: 'stderr' }));
```

### Providers

* `ConsoleProvider`: Writes newline-delimited JSON (or the output of a custom
  serializer) to stdout or stderr using `fs.Utf8Stream`.
* `EventProvider`: An `EventEmitter` that emits events.
* `DiagnosticsProvider`: Publishes events to `diagnostics_channel` channels.
* `AggregateProvider`: Fans events out to multiple providers.

A provider is any object with a synchronous `log(event, context)` method, and
optionally an `isEnabled(level, context)` method:

```js
const provider = {
  isEnabled(level) {
    return level.value >= 30;
  },
  log(event) {
    // Forward the event to another logger, a buffer, a remote service, etc.
  },
};
const logger = require('@nodejs/logger')(provider);
```

### Diagnostics channels

Every enabled event is traced through the `nodejs:logger:log` tracing channel,
whenever it has subscribers. Tools can observe events and add data to them
without the application having to configure anything. See the
[API reference](./doc/api.md#diagnostics-channels).

## Documentation

See the [API reference](./doc/api.md).

## Development

```sh
npm install
npm test            # Run the tests
npm run test:types  # Check the TypeScript declarations
npm run lint        # Lint the code
npm run bench       # Run the benchmarks
```

Library code uses the built-ins captured in `lib/internal/primordials.js`,
following the conventions of Node.js core, so that it can be vendored into
Node.js.

## License

[MIT](./LICENSE)
