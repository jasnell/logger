'use strict';

// A subset of Node.js core's internal/validators.

const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeJoin,
  ArrayPrototypeMap,
  NumberIsInteger,
  NumberMAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER,
  String,
} = require('./primordials');

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_OUT_OF_RANGE,
  },
} = require('./errors');

function validateArray(value, name, minLength = 0) {
  if (!ArrayIsArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
  if (value.length < minLength) {
    const reason = `must have a length of at least ${minLength}`;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean')
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
}

function validateFunction(value, name) {
  if (typeof value !== 'function')
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
}

function validateInteger(
  value, name, min = NumberMIN_SAFE_INTEGER, max = NumberMAX_SAFE_INTEGER) {
  if (typeof value !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!NumberIsInteger(value))
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max)
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

// Only the default behavior of core's validateObject(): rejects null, arrays,
// and functions.
function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || ArrayIsArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

function validateOneOf(value, name, oneOf) {
  if (!ArrayPrototypeIncludes(oneOf, value)) {
    const allowed = ArrayPrototypeJoin(
      ArrayPrototypeMap(oneOf, (v) =>
        (typeof v === 'string' ? `'${v}'` : String(v))),
      ', ');
    const reason = 'must be one of: ' + allowed;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string')
    throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
}

module.exports = {
  validateArray,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateObject,
  validateOneOf,
  validateString,
};
