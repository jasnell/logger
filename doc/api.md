# API reference

The `@nodejs/logger` module provides a structured logging facade. A logger
composes log events and passes them to a provider. Providers control filtering,
encoding, buffering, and output.

```mjs
import create from '@nodejs/logger';

const logger = create({ name: 'example' });
logger.info('server started', { port: 3000 });
```

```cjs
const create = require('@nodejs/logger');

const logger = create({ name: 'example' });
logger.info('server started', { port: 3000 });
```

The module exports the [`logger.create()`][] function, with the other exports
as properties of it. ES modules can also import each export by name. The ESM
and CommonJS entry points share a single instance of the module.

## Log events

Providers receive a log event with the following properties:

* `timestamp` {number} Milliseconds since the Unix epoch.
* `level` {Object}
  * `name` {string} The level name.
  * `value` {number} The numeric level value. Larger values are more severe.
* `name` {string|undefined} The logger name.
* `message` {any} The log message value.
* `bindings` {Object} Attributes associated with the logger and its parents.
* `attributes` {Object} Attributes supplied for this event.

A new event object is created for each log call and is not frozen. The
`attributes` object is a shallow copy of the attributes supplied for the event
and is not frozen. Built-in levels and the logger's bindings are shared between
events and are shallowly frozen. When a direct value of the bindings is a
function, `bindings` is instead a new, unfrozen copy. The message value is
retained as provided and is not cloned or frozen. Nested values are not cloned
or frozen. Providers should treat the entire event as read-only, since an
[`AggregateProvider`][] passes the same event to each of its providers, and
must copy nested values before retaining or modifying them asynchronously.

If a direct value of `bindings` or `attributes` is a function, the logger invokes
it for every event and replaces it in the event with the returned value. Nested
functions are not invoked.

## `logger.getDefaultProvider()`

* Returns: {Object}

Returns the provider used when a logger is created without an explicit provider.
Until set, the first call or logger creation lazily creates a
[`ConsoleProvider`][]. The same default provider is reused by subsequent loggers.

The default provider is process-wide. When a dependency tree contains multiple
copies of `@nodejs/logger`, they share the same default provider, so that
libraries can create loggers without an explicit provider and still log to the
provider configured by the application, whichever copy it used. Note that
`instanceof` checks against provider classes from another copy fail.

## `logger.setDefaultProvider(provider)`

* `provider` {Object} The provider to use by default.

Sets the provider used when a logger is created without an explicit provider.
Existing loggers retain their provider.

```cjs
const create = require('@nodejs/logger');

create.setDefaultProvider(new create.EventProvider());
const logger = create();
```

When `provider` differs from the current default, the process emits the
[`'defaultLoggerProviderChanged'`][] event with `provider` and the current
default provider. This event allows an application to detect when a dependency
changes the default provider. If the application does not wish to allow the
default provider to be changed, it can throw an error synchronously which will
be propagated up to the code that called `setDefaultProvider()`.

Calling `setDefaultProvider()` from a `'defaultLoggerProviderChanged'` listener
throws an `ERR_INVALID_STATE` error.

### Event: `'defaultLoggerProviderChanged'`

* `provider` {Object} The new default logger provider.
* `defaultProvider` {Object|undefined} The default logger provider at the time
  the event is emitted.

Emitted on `process`, synchronously, when [`logger.setDefaultProvider()`][] is
called with a provider that differs from the current default provider.

```cjs
process.on('defaultLoggerProviderChanged', (provider, defaultProvider) => {
  throw new Error('The default logger provider is managed by the application');
});
```

## `logger.create([provider][, options])`

* `provider` {Object} The provider that receives log events. **Default:**
  The value returned by [`logger.getDefaultProvider()`][].
* `options` {Object}
  * `name` {string} The logger name.
  * `bindings` {Object} Attributes included in every event from the logger.
    **Default:** `{}`.
* Returns: {Logger}

Creates a logger. If the first argument does not implement the provider
contract, it is treated as `options`.

```cjs
const { create, EventProvider } = require('@nodejs/logger');

const defaultLogger = create();

const provider = new EventProvider();
provider.on('log', (event) => {
  // Handle the structured event.
});
const eventLogger = create(provider, {
  name: 'api',
  bindings: { service: 'users' },
});
```

## Provider contract

A provider is an object with a synchronous `log(event, context)` method. It may also
implement `isEnabled(level, context)` to prevent events from being composed:

```cjs
class CustomProvider {
  isEnabled(level, context) {
    return level.value >= 30;
  }

  log(event, context) {
    // Handle the structured event.
  }
}
```

The `level` passed to `isEnabled()` is a level descriptor, which is frozen for
built-in levels. The same `context` object is passed to both methods for every
event from a logger and contains the logger's `name` and `bindings`. Providers
should not modify it. Only an exact `false` return value disables the event. A
provider without `isEnabled()` receives every event.

Provider methods run synchronously in the logging call. Exceptions propagate to
the caller. A provider that performs asynchronous work must enqueue or copy the
event synchronously.

## Class: `Logger`

### `new Logger([provider][, options])`

* `provider` {Object} The provider that receives log events. **Default:**
  The value returned by [`logger.getDefaultProvider()`][].
* `options` {Object}
  * `name` {string} The logger name.
  * `bindings` {Object} Attributes included in every event from the logger.

Equivalent to [`logger.create()`][].

### `logger.provider`

* {Object}

The provider used by the logger. The property is read-only.

### `logger.name`

* {string|undefined}

The logger name.

### `logger.bindings`

* {Object}

The shallowly frozen bindings associated with the logger.

### `logger.trace(message[, attributes])`

### `logger.debug(message[, attributes])`

### `logger.info(message[, attributes])`

### `logger.warn(message[, attributes])`

### `logger.error(message[, attributes])`

### `logger.fatal(message[, attributes])`

* `message` {any} The log message value.
* `attributes` {Object} Attributes associated with this event. **Default:** `{}`.

Creates a structured event at the corresponding level and passes it to the
provider if the provider enables that level.

When the provider is a [`ConsoleProvider`][], an [`EventProvider`][], or an
[`AggregateProvider`][] made up only of those providers and providers without
`isEnabled()`, these methods are resolved when the logger is created and again
whenever a provider's `level` changes. Methods for disabled levels are then a
shared no-op function, so calling them does not consult the provider. The
JavaScript engine can usually optimize such calls away entirely. Because of
this, methods for disabled levels do not validate their receiver or arguments.
For other providers, including providers that override `isEnabled()`, each call
checks `isEnabled()`.

```cjs
const { ConsoleProvider, create } = require('@nodejs/logger');

const provider = new ConsoleProvider({ level: 'info' });
const logger = create(provider);
logger.debug('not logged'); // No-op.
provider.level = 'debug';
logger.debug('logged');
```

```cjs
logger.info('request completed', {
  method: 'GET',
  statusCode: 200,
});
```

### `logger.log(level, message[, attributes])`

* `level` {string|Object} A built-in level name or an object containing a
  `name` {string} and integer `value` {number}.
* `message` {any} The log message value.
* `attributes` {Object} Attributes associated with this event. **Default:** `{}`.

Creates an event at a built-in or custom level.

```cjs
logger.log({ name: 'notice', value: 35 }, 'configuration reloaded');
```

### `logger.isEnabled(level)`

* `level` {string|Object} A built-in level name or custom level descriptor.
* Returns: {boolean}

Returns whether the provider enables the level for this logger.

### `logger.child(bindings[, options])`

* `bindings` {Object} Additional logger bindings.
* `options` {Object}
  * `name` {string} A name for the child. **Default:** The parent logger's name.
* Returns: {Logger}

Creates a logger that uses the same provider and adds to the parent's bindings.
Child bindings with the same key replace parent bindings.

## Class: `AggregateProvider`

The `AggregateProvider` delivers log events to a fixed list of providers. It
enables an event when at least one provider enables it. Each provider's
`isEnabled()` method is checked again immediately before delivery, and a
provider that returns `false` does not receive the event. Providers are called
in list order. Exceptions propagate immediately and prevent later providers
from being called.

### `new AggregateProvider(providers)`

* `providers` {Object\[]} The providers that receive log events.

The array may be empty. The providers are copied and validated during
construction. Duplicate and nested aggregate providers are supported.

### `aggregateProvider.providers`

* {Object\[]}

The frozen provider list. The provider objects themselves are not frozen.

## Class: `ConsoleProvider`

The `ConsoleProvider` serializes each event and writes it followed by a newline
using [`fs.Utf8Stream`][]. Events are serialized as JSON by default.

### `new ConsoleProvider([options])`

* `options` {Object}
  * `destination` {string} Either `'stdout'` or `'stderr'`. **Default:**
    `'stdout'`.
  * `flatten` {boolean} Whether to copy bindings and attributes into the
    top-level serialized record. **Default:** `false`.
  * `level` {string|Object} The minimum enabled level. **Default:** `'info'`.
  * `maxLength` {number} The maximum internal buffer length. Writes that would
    exceed this value are dropped. **Default:** `0`, for no limit.
  * `minLength` {number} The minimum internal buffer length before an automatic
    flush. **Default:** `0`.
  * `periodicFlush` {number} The interval in milliseconds at which the stream
    is flushed. **Default:** `0`, for no periodic flush.
  * `pid` {boolean} Whether to add the process ID as a top-level `pid` property
    to serialized records. **Default:** `false`.
  * `serializer` {Function} A function that receives a log record and returns
    a string. **Default:** A JSON serializer.
  * `sync` {boolean} Whether writes are synchronous. **Default:** `false`.

When `flatten` is `true`, bindings are copied into the top-level record first,
followed by attributes. Attributes therefore replace bindings with the same
property name. The level descriptor is emitted as a numeric `level` property and
a string `levelName` property. The `level`, `levelName`, `message`, `name`, and
`timestamp` event properties, along with `pid` when enabled, take precedence
over both. The original `bindings` and `attributes` containers are not included
in the record.

The default serializer follows [`JSON.stringify()`][] semantics, including
calling `toJSON()` methods, with these additions:

* `BigInt` values are serialized as decimal strings.
* `Error` objects include their `name`, `message`, and `stack`, along with
  `code`, `cause`, `errors`, and enumerable properties when present.
* Circular references are serialized as the string `'[Circular]'`.

Values that [`JSON.stringify()`][] normally omits, such as `undefined`,
functions, and symbols used as object properties, are still omitted.

[`util.inspect()`][] can be used when JavaScript-style diagnostic output is
preferred over JSON:

```cjs
const { ConsoleProvider, create } = require('@nodejs/logger');
const { inspect } = require('node:util');

const logger = create(new ConsoleProvider({ serializer: inspect }));
logger.info('started', { processId: 1n });
```

### `consoleProvider.destination`

* {string}

The configured destination.

### `consoleProvider.flatten`

* {boolean}

Whether bindings and attributes are flattened into the serialized record.

### `consoleProvider.level`

* {Object}

The minimum level descriptor. Set this property to a built-in level name or a
custom level descriptor to update the minimum level.

### `consoleProvider.pid`

* {boolean}

Whether serialized records include the process ID.

### `consoleProvider.serializer`

* {Function}

The configured serializer.

### `consoleProvider.stream`

* {fs.Utf8Stream}

The underlying stream. Its `'drop'` event reports records dropped because of
`maxLength`.

### `consoleProvider.flush([callback])`

* `callback` {Function} Called when pending writes have completed.

Flushes pending writes.

### `consoleProvider.flushSync()`

Synchronously flushes pending writes. Avoid calling it while an asynchronous
write is in progress: depending on the Node.js version, [`fs.Utf8Stream`][]
either throws an `ERR_INVALID_STATE` error or may interleave output in that
case.

## Class: `DiagnosticsProvider`

The `DiagnosticsProvider` publishes enabled log events to
[`diagnostics_channel`][] channels. Events are only enabled for channels that
have subscribers.

### `new DiagnosticsProvider(channels)`

* `channels` {Object|Function} A channel mapping or routing function.

When `channels` is an object, each own string or symbol property is a channel
name and its value is a selector function that receives a level descriptor. The
event is published to every subscribed channel whose selector returns a truthy
value.

When `channels` is a function, it receives a level descriptor and returns the
string or symbol name of the channel to publish to. Returning `undefined`
disables the event. The selected channel must have subscribers for the event to
be enabled.

`DiagnosticsProvider.isEnabled()` invokes the routing function to resolve its
channel. For a channel mapping, it invokes selectors only for channels that
currently have subscribers and stops after the first matching selector. When an
event is enabled, the applicable routing function or selectors are invoked
again immediately before publishing it. These functions must not rely on being
called exactly once.

```cjs
const { DiagnosticsProvider, create, levels } = require('@nodejs/logger');

const provider = new DiagnosticsProvider({
  'application:log': () => true,
  'application:error': (level) => level.value >= levels.error.value,
});
const logger = create(provider);
```

## Class: `EventProvider`

* Extends: {EventEmitter}

For each enabled log event, the `EventProvider` first checks for listeners whose
event name exactly matches the level name. If any exist, it emits the event using
the level name. Otherwise, it emits a `'log'` event. Event selection is based
only on the level name, not its numeric value. The provider does not buffer log
events, so events emitted without a matching or fallback listener are discarded.

### `new EventProvider([options])`

* `options` {Object}
  * `level` {string|Object} The minimum enabled level. **Default:** `'trace'`.

### Event: `'<level name>'`

* `event` {Object} The structured log event.

Emitted synchronously when the provider has a listener for the exact level name.
This event takes precedence over the `'log'` event.

```mjs
import { create, EventProvider } from '@nodejs/logger';

const ep = new EventProvider();

ep.on('warn', (event) => {
  // Receives all warn logs
});

ep.on('log', (event) => {
  // Receives all other logs
});

const logger = create(ep);
logger.warn('warning!');
logger.info('info!');
```

### Event: `'log'`

* `event` {Object} The structured log event.

Emitted synchronously when the provider has no listener for the event's level
name.

### `eventProvider.level`

* {Object}

The minimum level descriptor. Set this property to a built-in level name or a
custom level descriptor to update the minimum level.

## Diagnostics channels

Every enabled log event is traced through the `nodejs:logger:log`
[`TracingChannel`][] while it is delivered to the logger's provider, whenever
the channel has subscribers. Tools such as APM agents only need to subscribe;
no change to how the application configures its loggers or providers is
needed. The underlying channels are:

* `tracing:nodejs:logger:log:start`: Published before the provider's `log()`
  method is called.
* `tracing:nodejs:logger:log:end`: Published after the provider's `log()`
  method returns or throws.
* `tracing:nodejs:logger:log:error`: Published, before `end`, if the
  provider's `log()` method throws.

The message published to each channel is an object with the following
properties:

* `event` {Object} The [log event][] passed to the provider. This is the real
  event object, not a copy.
* `context` {Object} The context passed to the provider, containing the
  logger's `name` and `bindings`.
* `error` {any} Set if the provider's `log()` method throws.
* `result` {any} Set to the return value of the provider's `log()` method.

The same message object is published to every channel for a given event, so
`start` subscribers can modify the event before the provider receives it, and
`end` subscribers can restore it afterwards. When the channel has subscribers,
`event.attributes` is always a new, mutable object, even if no attributes were
passed. `event.bindings` may be the logger's shared, frozen bindings, so it must
be replaced rather than modified:

```cjs
const { tracingChannel } = require('node:diagnostics_channel');

const original = new WeakMap();
tracingChannel('nodejs:logger:log').subscribe({
  start(message) {
    const { event } = message;
    event.attributes.traceId = getCurrentTraceId();
    original.set(message, event.bindings);
    event.bindings = { ...event.bindings, service: 'checkout' };
  },
  end(message) {
    message.event.bindings = original.get(message);
  },
  asyncStart() {},
  asyncEnd() {},
  error() {},
});
```

Stores bound to the `start` channel with [`channel.bindStore()`][] are active
while the provider runs.

Only events that the logger's provider enables are published. Events for
disabled levels are discarded before an event is composed, so they never reach
the channel.

## `logger.levels`

* {Object}

Immutable descriptors for the built-in levels:

| Name    | Value |
| ------- | ----: |
| `trace` |    10 |
| `debug` |    20 |
| `info`  |    30 |
| `warn`  |    40 |
| `error` |    50 |
| `fatal` |    60 |

[`'defaultLoggerProviderChanged'`]: #event-defaultloggerproviderchanged
[`AggregateProvider`]: #class-aggregateprovider
[`ConsoleProvider`]: #class-consoleprovider
[`EventProvider`]: #class-eventprovider
[`JSON.stringify()`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify
[`TracingChannel`]: https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel
[`channel.bindStore()`]: https://nodejs.org/api/diagnostics_channel.html#channelbindstorestore-transform
[`diagnostics_channel`]: https://nodejs.org/api/diagnostics_channel.html
[`fs.Utf8Stream`]: https://nodejs.org/api/fs.html#class-fsutf8stream
[`logger.create()`]: #loggercreateprovider-options
[`logger.getDefaultProvider()`]: #loggergetdefaultprovider
[`logger.setDefaultProvider()`]: #loggersetdefaultproviderprovider
[`util.inspect()`]: https://nodejs.org/api/util.html#utilinspectobject-options
[log event]: #log-events
