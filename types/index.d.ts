import { EventEmitter } from 'node:events';
import { Utf8Stream } from 'node:fs';

declare namespace create {
  /** The names of the built-in levels. */
  type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

  /** A level descriptor. Larger values are more severe. */
  interface Level {
    readonly name: string;
    readonly value: number;
  }

  /** A built-in level name, or a custom level descriptor. */
  type LevelInput = LevelName | Level;

  /**
   * Bindings or attributes. Direct values that are functions are invoked
   * for every event, and replaced in the event by their return value.
   */
  type Attributes = { [key: string | symbol]: unknown };

  /**
   * The context passed to providers. The same object is passed for every
   * event from a logger. Providers should not modify it.
   */
  interface LoggerContext {
    readonly name: string | undefined;
    readonly bindings: Readonly<Attributes>;
  }

  /** A structured log event, as passed to providers. */
  interface LogEvent {
    /** Milliseconds since the Unix epoch. */
    timestamp: number;
    level: Level;
    /** The logger name. */
    name: string | undefined;
    /** The log message value, as provided. */
    message: unknown;
    /** Attributes associated with the logger and its parents. */
    bindings: Attributes;
    /** Attributes supplied for this event. */
    attributes: Attributes;
  }

  /**
   * The provider contract. Provider methods are called synchronously in the
   * logging call.
   */
  interface Provider {
    /**
     * Returns whether events at `level` should be composed. Only an exact
     * `false` return value disables the event.
     */
    isEnabled?(level: Level, context?: LoggerContext): boolean;
    log(event: LogEvent, context?: LoggerContext): void;
  }

  interface LoggerOptions {
    /** The logger name. */
    name?: string | undefined;
    /** Attributes included in every event from the logger. */
    bindings?: Attributes | undefined;
  }

  interface ChildLoggerOptions {
    /** A name for the child. Defaults to the parent logger's name. */
    name?: string | undefined;
  }

  type LogMethod = (message?: unknown, attributes?: Attributes) => void;

  class Logger {
    constructor(provider?: Provider | null, options?: LoggerOptions);
    constructor(options?: LoggerOptions);

    /** The provider used by the logger. */
    readonly provider: Provider;
    /** The logger name. */
    readonly name: string | undefined;
    /** The shallowly frozen bindings associated with the logger. */
    readonly bindings: Readonly<Attributes>;

    /** Returns whether the provider enables the level for this logger. */
    isEnabled(level: LevelInput): boolean;
    /** Creates an event at a built-in or custom level. */
    log(level: LevelInput, message?: unknown, attributes?: Attributes): void;
    trace: LogMethod;
    debug: LogMethod;
    info: LogMethod;
    warn: LogMethod;
    error: LogMethod;
    fatal: LogMethod;
    /**
     * Creates a logger that uses the same provider and adds to the parent's
     * bindings.
     */
    child(bindings: Attributes, options?: ChildLoggerOptions): Logger;
  }

  /** Delivers log events to a fixed list of providers. */
  class AggregateProvider implements Provider {
    constructor(providers: readonly Provider[]);
    /** The frozen provider list. */
    readonly providers: readonly Provider[];
    isEnabled(level: Level, context?: LoggerContext): boolean;
    log(event: LogEvent, context?: LoggerContext): void;
  }

  /** The record passed to a ConsoleProvider serializer. */
  type LogRecord = LogEvent | { [key: string]: unknown };

  interface ConsoleProviderOptions {
    /** **Default:** `'stdout'`. */
    destination?: 'stdout' | 'stderr' | undefined;
    /**
     * Whether to copy bindings and attributes into the top-level serialized
     * record. **Default:** `false`.
     */
    flatten?: boolean | undefined;
    /** The minimum enabled level. **Default:** `'info'`. */
    level?: LevelInput | undefined;
    /**
     * The maximum number of characters to buffer. Records are written before
     * the buffer would exceed it, and a longer record is dropped.
     * **Default:** `0`, for no limit.
     */
    maxLength?: number | undefined;
    /**
     * When greater than `0`, records are buffered until at least this many
     * characters are, instead of being written at the end of each turn of the
     * event loop. Must be less than 1 MiB. **Default:** `0`.
     */
    minLength?: number | undefined;
    /**
     * The interval in milliseconds at which buffered records are written.
     * **Default:** `0`, for no periodic flush.
     */
    periodicFlush?: number | undefined;
    /**
     * Whether to add the process ID as a top-level `pid` property.
     * **Default:** `false`.
     */
    pid?: boolean | undefined;
    /** Serializes a log record to a string. **Default:** A JSON serializer. */
    serializer?: ((record: LogRecord) => string) | undefined;
    /**
     * Whether each record is written as soon as it is logged, rather than at
     * the end of the turn of the event loop. **Default:** `false`.
     */
    sync?: boolean | undefined;
  }

  /**
   * Writes serialized log events to stdout or stderr, in synchronous batches
   * that do not interleave with batches written by other threads.
   */
  class ConsoleProvider implements Provider {
    constructor(options?: ConsoleProviderOptions);
    readonly destination: 'stdout' | 'stderr';
    readonly flatten: boolean;
    /** The minimum level. Accepts a level name or descriptor when set. */
    get level(): Level;
    set level(level: LevelInput);
    readonly pid: boolean;
    readonly serializer: (record: LogRecord) => string;
    /** The underlying stream, used in synchronous mode. */
    readonly stream: Utf8Stream;
    isEnabled(level: Level): boolean;
    log(event: LogEvent, context?: LoggerContext): void;
    /**
     * Writes buffered records synchronously, then calls `callback`
     * asynchronously with `null` or the write error.
     */
    flush(callback?: (err: Error | null) => void): void;
    /** Writes buffered records synchronously. Throws write errors. */
    flushSync(): void;
  }

  interface EventProviderOptions {
    /** The minimum enabled level. **Default:** `'trace'`. */
    level?: LevelInput | undefined;
  }

  /**
   * Emits log events using the level name when it has listeners for it,
   * otherwise as `'log'` events.
   */
  class EventProvider extends EventEmitter<{ [event: string]: [LogEvent] }>
    implements Provider {
    constructor(options?: EventProviderOptions);
    /** The minimum level. Accepts a level name or descriptor when set. */
    get level(): Level;
    set level(level: LevelInput);
    isEnabled(level: Level): boolean;
    log(event: LogEvent): void;
  }

  /** The message published to the `nodejs:logger:log` tracing channel. */
  interface LogChannelMessage {
    /** The event delivered to the provider. */
    event: LogEvent;
    context: LoggerContext;
    /** Set by TracingChannel when the provider throws. */
    error?: unknown;
    /** Set by TracingChannel when the provider returns. */
    result?: unknown;
  }

  /** Creates a logger. */
  function create(provider?: Provider | null, options?: LoggerOptions): Logger;
  function create(options?: LoggerOptions): Logger;

  /**
   * Returns the provider used when a logger is created without an explicit
   * provider.
   */
  function getDefaultProvider(): Provider;

  /**
   * Sets the provider used when a logger is created without an explicit
   * provider.
   */
  function setDefaultProvider(provider: Provider): void;

  /** Immutable descriptors for the built-in levels. */
  const levels: { readonly [K in LevelName]: Level & { readonly name: K } };
}

/** Creates a logger. */
declare function create(
  provider?: create.Provider | null,
  options?: create.LoggerOptions,
): create.Logger;
declare function create(options?: create.LoggerOptions): create.Logger;

export = create;

declare global {
  namespace NodeJS {
    interface Process {
      on(
        event: 'defaultLoggerProviderChanged',
        listener: (
          provider: create.Provider,
          defaultProvider: create.Provider | undefined,
        ) => void,
      ): this;
      once(
        event: 'defaultLoggerProviderChanged',
        listener: (
          provider: create.Provider,
          defaultProvider: create.Provider | undefined,
        ) => void,
      ): this;
    }
  }
}
