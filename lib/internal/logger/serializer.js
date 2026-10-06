'use strict';

// The default ConsoleProvider serializer, and a fast path that produces the
// same output for events created by Logger.

const {
  ArrayPrototypeIncludes,
  ArrayPrototypePop,
  ArrayPrototypePush,
  JSONStringify,
  NumberIsFinite,
  ObjectAssign,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty,
  SafeMap,
  SafeWeakMap,
  String,
  StringPrototypeCharCodeAt,
  Symbol,
} = require('../primordials');

const { isError } = require('../util');
const {
  NullPrototypeObject,
  getCachedSerializedBindings,
  isLogEvent,
  kLevelNames,
  kNullPrototype,
  levels,
} = require('./objects');

function serializeError(error) {
  const {
    message,
    name,
    stack,
    code,
    cause,
    errors,
  } = error;
  const detail = { message, name, stack };
  const withCode = code !== undefined ? { code } : null;
  const withCause = cause !== undefined ? { cause } : null;
  const withErrors = errors !== undefined ? { errors } : null;
  return ObjectAssign(new NullPrototypeObject(), error, detail,
                      withCode, withCause, withErrors);
}

function defaultSerializer(event) {
  const ancestors = [];
  // Maps serialized errors back to the original. Only created if needed.
  let replacements;

  return JSONStringify(event, function replacer(_key, value) {
    if (typeof value === 'bigint') return String(value);
    if (value === null || typeof value !== 'object') return value;

    const holder = replacements?.get(this) ?? this;
    while (ancestors.length > 0 &&
           ancestors[ancestors.length - 1] !== holder) {
      ArrayPrototypePop(ancestors);
    }
    if (ArrayPrototypeIncludes(ancestors, value)) return '[Circular]';
    ArrayPrototypePush(ancestors, value);

    if (isError(value)) {
      const serialized = serializeError(value);
      replacements ??= new SafeWeakMap();
      replacements.set(serialized, value);
      return serialized;
    }
    return value;
  });
}

// Fast path for ConsoleProvider with the default serializer
//
// Builds the JSON text for a Logger event directly, without creating a
// record object or calling JSON.stringify() with a replacer for every value.
// It produces exactly the output of defaultSerializer() for the record, and
// gives up (returns undefined) whenever that might not hold: any value that
// is not a primitive or an Error (objects, arrays, BigInt), errors that
// define toJSON() or `errors` or are nested too deeply, and, when
// flattening, any key that collides with another or is an array index
// (which JSON orders first).

// Returned when the generic serializer must be used.
const kGeneric = Symbol('kGeneric');

// Errors nested deeper than this (through `cause` or other properties) use
// the generic serializer. This also stops cycles, which it reports as
// '[Circular]'.
const kMaxErrorDepth = 8;

// Short strings without characters that JSON escapes are quoted directly.
// Surrogates are left to JSONStringify(), which escapes lone ones.
function serializeString(value) {
  if (value.length > 64) return JSONStringify(value);
  for (let i = 0; i < value.length; i++) {
    const code = StringPrototypeCharCodeAt(value, i);
    if (code < 0x20 || code === 0x22 || code === 0x5c ||
        (code >= 0xd800 && code <= 0xdfff)) {
      return JSONStringify(value);
    }
  }
  return `"${value}"`;
}

// Property name -> `"name":`. Bounded, since keys may be data.
const kMaxCachedKeys = 1024;
const serializedKeyCache = new SafeMap();

function serializeKey(key) {
  let json = serializedKeyCache.get(key);
  if (json === undefined) {
    json = `${serializeString(key)}:`;
    if (serializedKeyCache.size < kMaxCachedKeys) {
      serializedKeyCache.set(key, json);
    }
  }
  return json;
}

function isIndexLikeKey(key) {
  // JSON orders array index keys first. Conservatively treat any key
  // starting with a digit as one.
  const code = StringPrototypeCharCodeAt(key, 0);
  return code >= 48 && code <= 57;
}

// Returns the JSON text for a primitive value, undefined if JSON omits it,
// or kGeneric.
function serializePrimitive(value) {
  switch (typeof value) {
    case 'string': return serializeString(value);
    case 'number': return NumberIsFinite(value) ? `${value}` : 'null';
    case 'boolean': return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      return value === null ? 'null' : kGeneric;
    default:
      // BigInt: may have a user-defined toJSON().
      return kGeneric;
  }
}

// Like serializePrimitive(), but also serializes errors.
function serializeValue(value, depth) {
  if (typeof value === 'object' && value !== null && isError(value)) {
    return serializeErrorFast(value, depth);
  }
  return serializePrimitive(value);
}

/**
 * Serializes an error the way defaultSerializer() does (see
 * serializeError()): its own enumerable properties, followed by `message`,
 * `name`, `stack`, `code`, and `cause` if not already present.
 * @param {Error} error
 * @param {number} depth
 * @returns {string|symbol} The JSON text, or kGeneric.
 */
function serializeErrorFast(error, depth) {
  if (depth >= kMaxErrorDepth || typeof error.toJSON === 'function') {
    return kGeneric;
  }
  const { message, name, stack, code, cause, errors } = error;
  if (errors !== undefined) return kGeneric;

  const keys = ObjectKeys(error);
  let out = '';
  let hasMessage = false;
  let hasName = false;
  let hasStack = false;
  let hasCode = false;
  let hasCause = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let value;
    switch (key) {
      case 'message': hasMessage = true; value = message; break;
      case 'name': hasName = true; value = name; break;
      case 'stack': hasStack = true; value = stack; break;
      case 'code': hasCode = true; value = code; break;
      case 'cause': hasCause = true; value = cause; break;
      case 'errors': continue; // Undefined, checked above.
      default:
        if (isIndexLikeKey(key)) return kGeneric;
        value = error[key];
    }
    const json = serializeValue(value, depth + 1);
    if (json === kGeneric) return kGeneric;
    if (json !== undefined) {
      out += `${out === '' ? '' : ','}${serializeKey(key)}${json}`;
    }
  }

  // Appended in this order, if not own enumerable properties of the error.
  if (!hasMessage) out = appendErrorField(out, 'message', message, depth);
  if (!hasName && out !== kGeneric) {
    out = appendErrorField(out, 'name', name, depth);
  }
  if (!hasStack && out !== kGeneric) {
    out = appendErrorField(out, 'stack', stack, depth);
  }
  if (!hasCode && code !== undefined && out !== kGeneric) {
    out = appendErrorField(out, 'code', code, depth);
  }
  if (!hasCause && cause !== undefined && out !== kGeneric) {
    out = appendErrorField(out, 'cause', cause, depth);
  }
  return out === kGeneric ? kGeneric : `{${out}}`;
}

function appendErrorField(out, key, value, depth) {
  const json = serializeValue(value, depth + 1);
  if (json === kGeneric) return kGeneric;
  if (json === undefined) return out;
  return `${out}${out === '' ? '' : ','}${serializeKey(key)}${json}`;
}

// Keys that a flattened record sets itself, or that change JSON key order.
function isFlatReservedKey(key) {
  switch (key) {
    case 'level':
    case 'levelName':
    case 'message':
    case 'name':
    case 'pid':
    case 'timestamp':
      return true;
    default:
      return isIndexLikeKey(key);
  }
}

/**
 * Serializes the own enumerable string-keyed properties of `obj` as
 * comma-separated `"key":value` pairs.
 * @param {object} obj
 * @param {boolean} allowErrors Whether values may be errors. Bindings may
 *   not, since their serialization is cached and errors are mutable.
 * @param {object} [flatBindings] When flattening attributes, the bindings
 *   they are merged with. Reserved and colliding keys return kGeneric.
 * @returns {string|symbol} The pairs, or kGeneric.
 */
function serializeFields(obj, allowErrors, flatBindings,
                         keys = ObjectKeys(obj)) {
  let out = '';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (flatBindings !== undefined &&
        (isFlatReservedKey(key) ||
         ObjectPrototypeHasOwnProperty(flatBindings, key))) {
      return kGeneric;
    }
    const value = allowErrors ?
      serializeValue(obj[key], 0) : serializePrimitive(obj[key]);
    if (value === undefined) continue;
    if (value === kGeneric) return kGeneric;
    out += `${out === '' ? '' : ','}${serializeKey(key)}${value}`;
  }
  return out;
}

// Serialized bindings (and name) of a logger.
function SerializedBindings(fields, flatSafe, keys, name, nameFragment) {
  this.fields = fields;
  this.flatSafe = flatSafe;
  // ObjectKeys() of the bindings, for composeBindings().
  this.keys = keys;
  this.name = name;
  // `,"name":<name>`, or '' if there is no name.
  this.nameFragment = nameFragment ?? (name === undefined ? '' :
    `,"name":${serializeString(name)}`);
}
SerializedBindings.prototype = kNullPrototype;

// Serializes bindings for both nested and flattened records.
function serializeBindings(bindings, name) {
  const keys = ObjectKeys(bindings);
  const fields = serializeFields(bindings, false, undefined, keys);
  let flatSafe = fields !== kGeneric;
  if (flatSafe) {
    for (let i = 0; i < keys.length; i++) {
      if (isFlatReservedKey(keys[i])) {
        flatSafe = false;
        break;
      }
    }
  }
  return new SerializedBindings(fields, flatSafe, keys, name);
}

/**
 * Serializes a child logger's bindings by extending its parent's
 * serialization, if the child's bindings start with exactly the parent's
 * keys and values (no array index keys, no overridden values).
 * @param {object} bindings The child's merged bindings.
 * @param {object} parentBindings
 * @param {SerializedBindings} parentSerialized
 * @param {string|undefined} name The child's name.
 * @returns {SerializedBindings|undefined} undefined if not applicable.
 */
function composeBindings(bindings, parentBindings, parentSerialized, name) {
  if (parentSerialized.fields === kGeneric) return undefined;
  const keys = ObjectKeys(bindings);
  const parentKeys = parentSerialized.keys;
  const parentLength = parentKeys.length;
  if (keys.length < parentLength) return undefined;
  for (let i = 0; i < parentLength; i++) {
    const key = parentKeys[i];
    if (keys[i] !== key || bindings[key] !== parentBindings[key]) {
      return undefined;
    }
  }
  let fields = '';
  let flatSafe = parentSerialized.flatSafe;
  for (let i = parentLength; i < keys.length; i++) {
    const key = keys[i];
    if (isFlatReservedKey(key)) flatSafe = false;
    const value = serializePrimitive(bindings[key]);
    if (value === kGeneric) return undefined;
    if (value === undefined) continue;
    fields += `${fields === '' ? '' : ','}${serializeKey(key)}${value}`;
  }
  return new SerializedBindings(
    joinFields(parentSerialized.fields, fields),
    flatSafe,
    keys,
    name,
    name === parentSerialized.name ? parentSerialized.nameFragment : undefined);
}

// Computes the serialized bindings cached in a logger's context. Child
// loggers extend their parent's serialization when possible.
function computeContextSerializedBindings(bindings, name, parent,
                                          parentBindings) {
  let serialized;
  if (parent !== undefined) {
    serialized = composeBindings(
      bindings,
      parentBindings,
      getContextSerializedBindings(parent, parentBindings),
      name);
  }
  return serialized ?? serializeBindings(bindings, name);
}

// Returns the serialized bindings cached in `context` if it is the context of
// the logger that owns `bindings`, otherwise undefined.
function getContextSerializedBindings(context, bindings) {
  return getCachedSerializedBindings(context, bindings,
                                     computeContextSerializedBindings);
}

// Serialized bindings are cached per logger (in its context) when the event
// carries the logger's own frozen bindings, i.e. no binding is a function.
function getSerializedBindings(bindings, name, context) {
  const serialized = getCachedSerializedBindings(
    context, bindings, computeContextSerializedBindings);
  if (serialized !== undefined && serialized.name === name) return serialized;
  return serializeBindings(bindings, name);
}

// The serialized timestamp of the previous event, reused while consecutive
// events have the same timestamp.
let lastTimestamp = -1;
let lastTimestampJSON = '';

function SerializedLevel(nested, flat) {
  // `"level":{"name":...,"value":...}` contents and flattened fields.
  this.nested = nested;
  this.flat = flat;
}
SerializedLevel.prototype = kNullPrototype;

function serializeLevel(name, value) {
  const nameJSON = serializeString(name);
  return new SerializedLevel(`{"name":${nameJSON},"value":${value}}`,
                             `"level":${value},"levelName":${nameJSON}`);
}

// Built-in level -> SerializedLevel.
const serializedLevels = new SafeMap();
for (let i = 0; i < kLevelNames.length; i++) {
  const level = levels[kLevelNames[i]];
  serializedLevels.set(level, serializeLevel(level.name, level.value));
}

function joinFields(a, b) {
  if (a === '') return b;
  if (b === '') return a;
  return `${a},${b}`;
}

/**
 * Returns the line (what defaultSerializer() would produce for the record
 * ConsoleProvider creates from `event`, followed by a newline), or undefined
 * if the generic path must be used.
 * @param {object} event
 * @param {object} [context] The context passed to the provider.
 * @param {boolean} flatten
 * @param {string} pidJSON `,"pid":<pid>` if enabled, otherwise ''.
 * @returns {string|undefined}
 */
function serializeEventFast(event, context, flatten, pidJSON) {
  if (!isLogEvent(event)) return undefined;
  const { attributes, bindings, level, message, name, timestamp } = event;
  if (typeof attributes !== 'object' || attributes === null ||
      typeof bindings !== 'object' || bindings === null ||
      typeof level !== 'object' || level === null ||
      typeof timestamp !== 'number') {
    return undefined;
  }
  let serializedLevel = serializedLevels.get(level);
  if (serializedLevel === undefined) {
    const levelName = level.name;
    const levelValue = level.value;
    if (typeof levelName !== 'string' || !NumberIsFinite(levelValue)) {
      return undefined;
    }
    serializedLevel = serializeLevel(levelName, levelValue);
  }
  const messageJSON = serializeValue(message, 0);
  if (messageJSON === kGeneric) return undefined;
  if (name !== undefined && typeof name !== 'string') return undefined;

  const serializedBindings = getSerializedBindings(bindings, name, context);
  if (serializedBindings.fields === kGeneric) return undefined;

  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    lastTimestampJSON = `${timestamp}`;
  }
  const tail =
    `${messageJSON === undefined ? '' : `,"message":${messageJSON}`}` +
    `${serializedBindings.nameFragment},"timestamp":${lastTimestampJSON}` +
    `${pidJSON}}\n`;

  if (flatten) {
    if (!serializedBindings.flatSafe) return undefined;
    const attributeFields = serializeFields(attributes, true, bindings);
    if (attributeFields === kGeneric) return undefined;
    const fields = joinFields(serializedBindings.fields, attributeFields);
    return `{${fields === '' ? '' : `${fields},`}${serializedLevel.flat}` +
      tail;
  }

  const attributeFields = serializeFields(attributes, true);
  if (attributeFields === kGeneric) return undefined;
  return `{"attributes":{${attributeFields}},` +
    `"bindings":{${serializedBindings.fields}},` +
    `"level":${serializedLevel.nested}${tail}`;
}

module.exports = {
  defaultSerializer,
  serializeEventFast,
};
