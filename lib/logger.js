'use strict';

// The public entry point: Logger, create(), and the default provider.
// Implementation details live in ./internal/logger/:
//
// - objects.js: levels, logger contexts, events, and shared helpers.
// - dispatch.js: resolution of level methods ahead of time.
// - serializer.js: the default ConsoleProvider serializer.
// - providers/: the built-in providers.

const {
  DateNow,
  FunctionPrototypeCall,
  ObjectAssign,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetPrototypeOf,
  ObjectSetPrototypeOf,
  Symbol,
  SymbolFor,
} = require('./internal/primordials');

const {
  codes: {
    ERR_INVALID_STATE,
    ERR_INVALID_THIS,
  },
} = require('./internal/errors');
const {
  validateObject,
  validateString,
} = require('./internal/validators');
const { kEmptyObject } = require('./internal/util');
const { tracingChannel } = require('node:diagnostics_channel');
const {
  LogEvent,
  LogMessage,
  LoggerContext,
  NullPrototypeObject,
  copyObject,
  hasFunction,
  isProvider,
  isProviderEnabled,
  kEmptyAttributes,
  kEmptyBindings,
  kLevelNames,
  kNullPrototype,
  levels,
  normalizeLevel,
  validateProvider,
} = require('./internal/logger/objects');
const {
  getDispatchInfo,
  getDispatchPrototype,
  registerLogger,
} = require('./internal/logger/dispatch');
const {
  AggregateProvider,
} = require('./internal/logger/providers/aggregate');
const { ConsoleProvider } = require('./internal/logger/providers/console');
const { EventProvider } = require('./internal/logger/providers/event');

// Diagnostics channels
//
// Every enabled log event is traced through the `nodejs:logger:log` tracing
// channel while it is delivered to the logger's provider, whenever the
// channel has subscribers. No configuration is needed: subscribing is
// enough. The message published to the `start`, `end`, and `error` channels
// is `{ event, context }`, holding the real event passed to the provider,
// so `start` subscribers can modify the event before the provider sees it
// and `end` subscribers can restore it afterwards (`end` is published even
// if the provider throws, after `error`). Since this uses
// TracingChannel.traceSync(), stores bound to the `start` channel are also
// active while the provider runs.
//
// Events for levels that the provider disables are not published.
const kLogChannelName = 'nodejs:logger:log';
const logChannel = tracingChannel(kLogChannelName);
// traceSync() only publishes to these.
const {
  start: logStartChannel,
  end: logEndChannel,
  error: logErrorChannel,
} = logChannel;

let isLogger;

// Passed as the first constructor argument by child(), which has already
// validated its arguments, copied the bindings, and allocates the child with
// the right prototype. Not reachable by users.
const kLoggerInit = Symbol('kLoggerInit');

function LoggerInit(provider, name, bindings, childTarget, parentContext) {
  this.provider = provider;
  this.name = name;
  this.bindings = bindings;
  this.childTarget = childTarget;
  this.parentContext = parentContext;
}
LoggerInit.prototype = kNullPrototype;

class Logger {
  #bindings;
  // The class child() uses to allocate children with the provider's dispatch
  // prototype: undefined until first needed, null if there is none.
  #childTarget;
  #context;
  // Whether any binding is a function, or undefined until #materialize().
  #hasFunction;
  #name;
  #provider;

  static {
    isLogger = (obj) => {
      return obj !== null && typeof obj === 'object' && #provider in obj;
    };
  }

  constructor(providerOrOptions, options) {
    if (providerOrOptions === kLoggerInit) {
      // Internal (child()): already validated, bindings already copied, and
      // allocated with the right prototype. Freezing the bindings and looking
      // for functions in them is deferred (see #materialize()).
      this.#init(options.provider, options.name, options.bindings,
                 undefined, options.parentContext);
      this.#childTarget = options.childTarget;
      return;
    }

    let provider = providerOrOptions;
    if (provider == null) {
      provider = getDefaultProvider();
    } else if (options === undefined &&
               typeof provider === 'object' &&
               !isProvider(provider)) {
      options = provider;
      provider = getDefaultProvider();
    }

    options ??= kEmptyObject;
    validateProvider(provider);
    validateObject(options, 'options');

    const {
      bindings = kEmptyBindings,
      name,
    } = options;
    validateObject(bindings, 'options.bindings');
    if (name !== undefined) {
      validateString(name, 'options.name');
    }

    // Frozen, since the same object is passed as event.bindings for every
    // event when no binding is a function.
    const copy = ObjectFreeze(copyObject(bindings));
    this.#init(provider, name, copy, hasFunction(copy));

    // Interpose the shared dispatch prototype so that methods for disabled
    // levels resolve to an empty function. create() and child() allocate
    // loggers with it already in place (see constructLogger()). Otherwise,
    // e.g. for `new Logger()` and subclasses, it is swapped in here, using
    // the current prototype as the base so that subclasses keep their own
    // methods.
    const proto = ObjectGetPrototypeOf(this);
    const info = getDispatchInfo(proto);
    if (info?.provider !== provider) {
      // A dispatch prototype belonging to another provider (only reachable
      // via a crafted new.target) is replaced, starting from its base.
      const base = info === undefined ? proto : info.base;
      const dispatch = getDispatchPrototype(provider, base) ?? base;
      if (dispatch !== proto) {
        ObjectSetPrototypeOf(this, dispatch);
      }
    }
  }

  #init(provider, name, bindings, hasFunction, parentContext) {
    this.#provider = provider;
    this.#name = name;
    this.#bindings = bindings;
    this.#hasFunction = hasFunction;
    this.#context = new LoggerContext(bindings, name, parentContext);
  }

  get provider() {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    return this.#provider;
  }

  get name() {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    return this.#name;
  }

  get bindings() {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    if (this.#hasFunction === undefined) this.#materialize();
    return this.#bindings;
  }

  isEnabled(level) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    return this.#isEnabled(normalizeLevel(level));
  }

  log(level, message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(normalizeLevel(level), message, attributes);
  }

  trace(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.trace, message, attributes);
  }

  debug(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.debug, message, attributes);
  }

  info(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.info, message, attributes);
  }

  warn(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.warn, message, attributes);
  }

  error(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.error, message, attributes);
  }

  fatal(message, attributes = kEmptyAttributes) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    this.#log(levels.fatal, message, attributes);
  }

  child(bindings, options = kEmptyObject) {
    if (!isLogger(this)) {
      throw new ERR_INVALID_THIS('Logger');
    }
    validateObject(bindings, 'bindings');
    validateObject(options, 'options');

    const { name = this.#name } = options;
    if (name !== undefined) {
      validateString(name, 'options.name');
    }

    // Children share the provider, so they also share the class that
    // allocates them with its dispatch prototype. Resolved once per parent
    // and passed down to children.
    let childTarget = this.#childTarget;
    if (childTarget === undefined) {
      const dispatch = getDispatchPrototype(this.#provider, Logger.prototype);
      childTarget = dispatch === undefined ?
        null : getDispatchInfo(dispatch).target;
      this.#childTarget = childTarget;
    }

    // Not frozen yet: many children never log (e.g. only disabled levels),
    // so that is deferred until the bindings are observable. Nothing else can
    // reach them before then, so they cannot change meanwhile.
    const init = new LoggerInit(
      this.#provider,
      name,
      ObjectAssign(new NullPrototypeObject(), this.#bindings, bindings),
      childTarget,
      this.#context,
    );
    return childTarget === null ?
      new Logger(kLoggerInit, init) :
      new childTarget(kLoggerInit, init);
  }

  // Completes the setup that child() defers. Called before the bindings
  // become observable: through the bindings getter, or through the context
  // passed to the provider (every call to the provider goes through
  // #isEnabled()).
  #materialize() {
    ObjectFreeze(this.#bindings);
    this.#hasFunction = hasFunction(this.#bindings);
  }

  #isEnabled(level) {
    if (this.#hasFunction === undefined) this.#materialize();
    return isProviderEnabled(this.#provider, level, this.#context);
  }

  #log(level, message, attributes) {
    if (!this.#isEnabled(level)) {
      return;
    }

    validateObject(attributes, 'attributes');

    const traced = logStartChannel.hasSubscribers ||
      logEndChannel.hasSubscribers || logErrorChannel.hasSubscribers;

    const event = new LogEvent(
      // The shared empty attributes object is frozen. When traced, a new
      // object is created so that subscribers can add attributes to it.
      attributes === kEmptyAttributes && !traced ?
        attributes : copyObject(attributes, true),
      this.#hasFunction ? copyObject(this.#bindings, true) : this.#bindings,
      level,
      message,
      this.#name,
      DateNow(),
    );

    if (traced) {
      logChannel.traceSync(
        this.#provider.log,
        new LogMessage(event, this.#context),
        this.#provider,
        event,
        this.#context,
      );
      return;
    }

    FunctionPrototypeCall(
      this.#provider.log,
      this.#provider,
      event,
      this.#context,
    );
  }
}

function createDispatchClass(base) {
  if (base !== Logger.prototype) return undefined;
  // Uses the default derived constructor, which V8 skips entirely.
  const DispatchLogger = class extends Logger {};
  ObjectDefineProperty(DispatchLogger.prototype, 'constructor', {
    __proto__: null,
    configurable: true,
    enumerable: false,
    value: Logger,
    writable: true,
  });
  return DispatchLogger;
}

const levelMethods = {};
ObjectSetPrototypeOf(levelMethods, null);
for (let i = 0; i < kLevelNames.length; i++) {
  const name = kLevelNames[i];
  levelMethods[name] = Logger.prototype[name];
}
registerLogger(levelMethods, createDispatchClass);

/**
 * Creates a Logger whose prototype is the provider's dispatch prototype from
 * the start, if it has one. Equivalent to `new Logger(...)`, which instead
 * has to swap the prototype after allocation.
 * @param {any} providerOrOptions
 * @param {object} [options]
 * @returns {Logger}
 */
function constructLogger(providerOrOptions, options) {
  // Resolve the provider the same way the constructor does, without
  // validating. Anything the constructor would reject goes through the
  // regular path so that errors are reported identically.
  let provider = providerOrOptions;
  if (provider == null ||
      (options === undefined && typeof provider === 'object' &&
       !isProvider(provider))) {
    provider = getDefaultProvider();
  }
  if (isProvider(provider)) {
    const dispatch = getDispatchPrototype(provider, Logger.prototype);
    if (dispatch !== undefined) {
      const DispatchLogger = getDispatchInfo(dispatch).target;
      return new DispatchLogger(providerOrOptions, options);
    }
  }
  return new Logger(providerOrOptions, options);
}

function create(provider, options) {
  return constructLogger(provider, options);
}

// The default provider is process-wide state. Since a dependency tree may
// contain multiple copies of this package, the state is shared through a
// registry symbol on globalThis, so that a default provider set through any
// copy is used by loggers created through every other copy. Copies only
// share the state if they agree on its layout (kDefaultStateVersion);
// otherwise, the copy keeps its own state.
const kDefaultStateKey = SymbolFor('nodejs.logger.defaultProviderState');
const kDefaultStateVersion = 1;

function DefaultProviderState() {
  this.version = kDefaultStateVersion;
  this.provider = undefined;
  this.setting = false;
}
DefaultProviderState.prototype = kNullPrototype;

function getDefaultProviderState() {
  const existing = globalThis[kDefaultStateKey];
  if (existing !== undefined) {
    if (typeof existing === 'object' && existing !== null &&
        existing.version === kDefaultStateVersion) {
      return existing;
    }
    return new DefaultProviderState();
  }
  const state = new DefaultProviderState();
  ObjectDefineProperty(globalThis, kDefaultStateKey, {
    __proto__: null,
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

const defaultProviderState = getDefaultProviderState();

function getDefaultProvider() {
  defaultProviderState.provider ??= new ConsoleProvider();
  return defaultProviderState.provider;
}

function setDefaultProvider(provider) {
  const state = defaultProviderState;
  if (state.setting) {
    throw new ERR_INVALID_STATE('Already setting the default provider');
  }
  state.setting = true;
  try {
    // Note that we validate the provider after the `setting` check. That is
    // to prevent re-entrant calls that might happen when we try to access
    // the properties of the provider that is given.
    validateProvider(provider, 'defaultProvider');
    const current = state.provider;
    if (provider !== current &&
      process.listenerCount('defaultLoggerProviderChanged')) {
      process.emit('defaultLoggerProviderChanged', provider, current);
    }
    state.provider = provider;
  } finally {
    state.setting = false;
  }
}

function getDescriptor(value) {
  const desc = {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  };
  ObjectSetPrototypeOf(desc, null);
  return desc;
}

const properties = {
  AggregateProvider: getDescriptor(AggregateProvider),
  ConsoleProvider: getDescriptor(ConsoleProvider),
  EventProvider: getDescriptor(EventProvider),
  Logger: getDescriptor(Logger),
  create: getDescriptor(create),
  getDefaultProvider: getDescriptor(getDefaultProvider),
  levels: getDescriptor(levels),
  setDefaultProvider: getDescriptor(setDefaultProvider),
};
ObjectSetPrototypeOf(properties, null);
ObjectDefineProperties(create, properties);

module.exports = create;
