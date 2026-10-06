'use strict';

// Objects shared by loggers, providers, and the serializer: levels, logger
// contexts, events, and helpers to copy and validate them.

const {
  FunctionPrototypeCall,
  ObjectAssign,
  ObjectFreeze,
  ObjectGetOwnPropertySymbols,
  ObjectKeys,
  ObjectPrototypePropertyIsEnumerable,
  ObjectSetPrototypeOf,
} = require('../primordials');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = require('../errors');
const {
  validateFunction,
  validateInteger,
  validateObject,
  validateOneOf,
  validateString,
} = require('../validators');

// Objects created per logger or per event (levels, bindings, attributes,
// contexts, events, records) must not inherit from Object.prototype, and
// should be in fast properties mode. `{ __proto__: null }` literals and
// ObjectCreate(null) produce dictionary-mode objects, and calling
// ObjectSetPrototypeOf() on a new object is expensive. Instead, these
// objects are created by constructor functions whose prototype is this
// shared, empty, frozen object, whose own prototype is null. Such objects
// are allocated in fast mode and inherit no properties.
//
// Objects created only once (at module load or per provider) use
// ObjectSetPrototypeOf(obj, null) directly, since the cost is paid once.
const kNullPrototype = {};
ObjectSetPrototypeOf(kNullPrototype, null);
ObjectFreeze(kNullPrototype);

function NullPrototypeObject() {}
NullPrototypeObject.prototype = kNullPrototype;

function Level(name, value) {
  this.name = name;
  this.value = value;
}
Level.prototype = kNullPrototype;

// Returns the cached serialization of `bindings` if `context` is the context
// of the logger that owns them, computing it with `compute` the first time,
// otherwise undefined. See getContextSerializedBindings() in the serializer.
// Set in LoggerContext's static block.
let getCachedSerializedBindings;

class LoggerContext {
  // Internal state, invisible to providers.
  #bindings;
  #name;
  // The parent logger's context, for child loggers.
  #parent;
  // The serializer's SerializedBindings for #bindings, once computed.
  #serializedBindings;

  constructor(bindings, name, parent) {
    this.bindings = bindings;
    this.name = name;
    this.#bindings = bindings;
    this.#name = name;
    this.#parent = parent;
  }

  static {
    getCachedSerializedBindings = (context, bindings, compute) => {
      if (typeof context !== 'object' || context === null ||
          !(#bindings in context) || context.#bindings !== bindings) {
        return undefined;
      }
      let serialized = context.#serializedBindings;
      if (serialized === undefined) {
        // The bindings are frozen, and only cached if all values are
        // primitives (see serializeFields()), so this cannot go stale.
        const parent = context.#parent;
        serialized = compute(bindings, context.#name, parent,
                             parent?.#bindings);
        context.#serializedBindings = serialized;
      }
      return serialized;
    };
  }
}
// Contexts look like plain null-prototype objects to providers.
ObjectSetPrototypeOf(LoggerContext.prototype, null);
delete LoggerContext.prototype.constructor;
ObjectFreeze(LoggerContext.prototype);

// Returns whether `obj` is an event created by Logger. Set in LogEvent's
// static block.
let isLogEvent;

class LogEvent {
  // Lets ConsoleProvider recognize events created by Logger. Cheaper than
  // checking the prototype.
  #brand;

  constructor(attributes, bindings, level, message, name, timestamp) {
    this.attributes = attributes;
    this.bindings = bindings;
    this.level = level;
    this.message = message;
    this.name = name;
    this.timestamp = timestamp;
  }

  static {
    isLogEvent = (obj) => #brand in obj;
  }
}
// Events look like plain null-prototype objects to providers.
ObjectSetPrototypeOf(LogEvent.prototype, null);
delete LogEvent.prototype.constructor;
ObjectFreeze(LogEvent.prototype);

// The message published to the log tracing channel. TracingChannel adds
// `result` or `error` to it.
function LogMessage(event, context) {
  this.event = event;
  this.context = context;
}
LogMessage.prototype = kNullPrototype;

const kEmpty = ObjectFreeze(new NullPrototypeObject());
const kEmptyAttributes = kEmpty;
const kEmptyBindings = kEmpty;

// Objects created per event (events, attribute copies, custom levels passed
// to log(), records) are not frozen: each is new, so mutating one affects
// nothing else, consistent with EventEmitter and diagnostics_channel.
// Objects that are shared or reused (the built-in levels, provider level
// thresholds, logger bindings, kEmpty, kNullPrototype) are frozen.

// The built-in levels are shared by every logger and provider.
let levels = {
  trace: ObjectFreeze(new Level('trace', 10)),
  debug: ObjectFreeze(new Level('debug', 20)),
  info: ObjectFreeze(new Level('info', 30)),
  warn: ObjectFreeze(new Level('warn', 40)),
  error: ObjectFreeze(new Level('error', 50)),
  fatal: ObjectFreeze(new Level('fatal', 60)),
};
ObjectSetPrototypeOf(levels, null);
levels = ObjectFreeze(levels);
const kLevelNames = ObjectKeys(levels);

function normalizeLevel(level, name = 'level') {
  if (typeof level === 'string') {
    validateOneOf(level, name, kLevelNames);
    return levels[level];
  }

  validateObject(level, name);
  const { name: levelName, value } = level;
  validateString(levelName, `${name}.name`);
  validateInteger(value, `${name}.value`);
  return new Level(levelName, value);
}

// Provider level thresholds are frozen: they are exposed through the
// provider's `level` getter, and mutating one would change which levels are
// enabled without re-resolving loggers' level methods.
function normalizeThreshold(level, name = 'level') {
  return ObjectFreeze(normalizeLevel(level, name));
}

// Copies the own enumerable properties of `value`, like ObjectAssign().
// With `resolveFunctions`, function values are replaced by their return
// value, in the same pass.
function copyObject(value, resolveFunctions = false) {
  if (!resolveFunctions) {
    return ObjectAssign(new NullPrototypeObject(), value);
  }
  const copy = new NullPrototypeObject();
  const keys = ObjectKeys(value);
  for (let i = 0; i < keys.length; i++) {
    copyResolvedProperty(copy, value, keys[i]);
  }
  const symbols = ObjectGetOwnPropertySymbols(value);
  for (let i = 0; i < symbols.length; i++) {
    if (ObjectPrototypePropertyIsEnumerable(value, symbols[i])) {
      copyResolvedProperty(copy, value, symbols[i]);
    }
  }
  return copy;
}

function copyResolvedProperty(copy, value, key) {
  const entry = value[key];
  copy[key] = typeof entry === 'function' ?
    FunctionPrototypeCall(entry) : entry;
}

// Returns whether any own enumerable property (the ones copyObject() and
// ObjectAssign() copy) is a function. ObjectKeys() and
// ObjectGetOwnPropertySymbols() are much cheaper than ReflectOwnKeys().
function hasFunction(value) {
  const keys = ObjectKeys(value);
  for (let i = 0; i < keys.length; i++) {
    if (typeof value[keys[i]] === 'function') {
      return true;
    }
  }
  const symbols = ObjectGetOwnPropertySymbols(value);
  for (let i = 0; i < symbols.length; i++) {
    if (ObjectPrototypePropertyIsEnumerable(value, symbols[i]) &&
        typeof value[symbols[i]] === 'function') {
      return true;
    }
  }
  return false;
}

function isProvider(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.log === 'function';
}

function validateProvider(provider, name = 'provider') {
  if (provider === null ||
      (typeof provider !== 'object' && typeof provider !== 'function')) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Provider', provider);
  }

  validateFunction(provider.log, `${name}.log`);
  if (provider.isEnabled !== undefined) {
    validateFunction(provider.isEnabled, `${name}.isEnabled`);
  }
}

function isProviderEnabled(provider, level, context) {
  const isEnabled = provider.isEnabled;
  return isEnabled === undefined || FunctionPrototypeCall(
    isEnabled,
    provider,
    level,
    context,
  ) !== false;
}

module.exports = {
  LogEvent,
  LogMessage,
  LoggerContext,
  NullPrototypeObject,
  copyObject,
  getCachedSerializedBindings,
  hasFunction,
  isLogEvent,
  isProvider,
  isProviderEnabled,
  kEmptyAttributes,
  kEmptyBindings,
  kLevelNames,
  kNullPrototype,
  levels,
  normalizeLevel,
  normalizeThreshold,
  validateProvider,
};
