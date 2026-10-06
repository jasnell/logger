'use strict';

// A subset of Node.js core's internal/errors, producing errors with the same
// `code`, `name`, and `message` as their core counterparts.

const {
  ArrayIsArray,
  ArrayPrototypeIncludes,
  ArrayPrototypeIndexOf,
  ArrayPrototypeJoin,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ArrayPrototypeSplice,
  Error,
  ErrorCaptureStackTrace,
  JSONStringify,
  MathAbs,
  NumberIsInteger,
  ObjectDefineProperty,
  RangeError,
  RegExpPrototypeExec,
  String,
  StringPrototypeEndsWith,
  StringPrototypeIncludes,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  TypeError,
} = require('./primordials');

let inspect;
function lazyInspect(value, options) {
  inspect ??= require('node:util').inspect;
  return inspect(value, options);
}

const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

// Sorted by a rough estimate on most frequently used entries.
const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];

/**
 * Creates a constructor for errors with the given `code`, whose message is
 * produced by `format`. Like core, the stack trace starts with
 * `Name [CODE]: message`, `toString()` includes the code, and `name` is the
 * name of the base class.
 * @param {Function} Base
 * @param {string} code
 * @param {Function} format
 * @returns {Function}
 */
function makeNodeErrorWithCode(Base, code, format) {
  function NodeError(...args) {
    const error = new Base(format(...args));
    ErrorCaptureStackTrace?.(error, NodeError);
    // Include the code in the stack trace, then restore the inherited name.
    ObjectDefineProperty(error, 'name', {
      __proto__: null,
      value: `${error.name} [${code}]`,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    error.stack; // eslint-disable-line no-unused-expressions
    delete error.name;
    ObjectDefineProperty(error, 'toString', {
      __proto__: null,
      value() { return `${this.name} [${code}]: ${this.message}`; },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    error.code = code;
    return error;
  }
  return NodeError;
}

// Only use this for integers! Decimal numbers do not work with this function.
function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${StringPrototypeSlice(val, i - 3, i)}${res}`;
  }
  return `${StringPrototypeSlice(val, 0, i)}${res}`;
}

function determineSpecificType(value) {
  if (value === null) {
    return 'null';
  } else if (value === undefined) {
    return 'undefined';
  }

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return 'type number (NaN)';
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object': {
      const name = value.constructor?.name;
      if (typeof name === 'string' && name !== '') {
        return `an instance of ${name}`;
      }
      return `${lazyInspect(value, { depth: -1 })}`;
    }
    case 'string':
      value.length > 28 && (value = `${StringPrototypeSlice(value, 0, 25)}...`);
      if (StringPrototypeIndexOf(value, "'") === -1) {
        return `type string ('${value}')`;
      }
      return `type string (${JSONStringify(value)})`;
    default:
      value = lazyInspect(value, { colors: false });
      if (value.length > 28) {
        value = `${StringPrototypeSlice(value, 0, 25)}...`;
      }
      return `type ${type} (${value})`;
  }
}

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${ArrayPrototypeJoin(ArrayPrototypeSlice(array, 0, -1), ', ')}, ${type} ${array[array.length - 1]}`;
  }
}

const ERR_INVALID_ARG_TYPE = makeNodeErrorWithCode(
  TypeError,
  'ERR_INVALID_ARG_TYPE',
  (name, expected, actual) => {
    if (!ArrayIsArray(expected)) {
      expected = [expected];
    }

    let msg = 'The ';
    if (StringPrototypeEndsWith(name, ' argument')) {
      // For cases like 'first argument'
      msg += `${name} `;
    } else {
      const type = StringPrototypeIncludes(name, '.') ? 'property' : 'argument';
      msg += `"${name}" ${type} `;
    }
    msg += 'must be ';

    const types = [];
    const instances = [];
    const other = [];

    for (let i = 0; i < expected.length; i++) {
      const value = expected[i];
      if (ArrayPrototypeIncludes(kTypes, value)) {
        ArrayPrototypePush(types, StringPrototypeToLowerCase(value));
      } else if (RegExpPrototypeExec(classRegExp, value) !== null) {
        ArrayPrototypePush(instances, value);
      } else {
        ArrayPrototypePush(other, value);
      }
    }

    // Special handle `object` in case other instances are allowed to outline
    // the differences between each other.
    if (instances.length > 0) {
      const pos = ArrayPrototypeIndexOf(types, 'object');
      if (pos !== -1) {
        ArrayPrototypeSplice(types, pos, 1);
        ArrayPrototypePush(instances, 'Object');
      }
    }

    if (types.length > 0) {
      msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
      if (instances.length > 0 || other.length > 0)
        msg += ' or ';
    }

    if (instances.length > 0) {
      msg += `an instance of ${formatList(instances, 'or')}`;
      if (other.length > 0)
        msg += ' or ';
    }

    if (other.length > 0) {
      if (other.length > 1) {
        msg += `one of ${formatList(other, 'or')}`;
      } else {
        if (StringPrototypeToLowerCase(other[0]) !== other[0])
          msg += 'an ';
        msg += `${other[0]}`;
      }
    }

    msg += `. Received ${determineSpecificType(actual)}`;

    return msg;
  });

const ERR_INVALID_ARG_VALUE = makeNodeErrorWithCode(
  TypeError,
  'ERR_INVALID_ARG_VALUE',
  (name, value, reason = 'is invalid') => {
    let inspected = lazyInspect(value);
    if (inspected.length > 128) {
      inspected = `${StringPrototypeSlice(inspected, 0, 128)}...`;
    }
    const type = StringPrototypeIncludes(name, '.') ? 'property' : 'argument';
    return `The ${type} '${name}' ${reason}. Received ${inspected}`;
  });

const ERR_INVALID_RETURN_VALUE = makeNodeErrorWithCode(
  TypeError,
  'ERR_INVALID_RETURN_VALUE',
  (input, name, value) => {
    const type = determineSpecificType(value);
    return `Expected ${input} to be returned from the "${name}"` +
           ` function but got ${type}.`;
  });

const ERR_INVALID_STATE = makeNodeErrorWithCode(
  Error,
  'ERR_INVALID_STATE',
  (message) => `Invalid state: ${message}`);

const ERR_INVALID_THIS = makeNodeErrorWithCode(
  TypeError,
  'ERR_INVALID_THIS',
  (type) => `Value of "this" must be of type ${type}`);

const ERR_OUT_OF_RANGE = makeNodeErrorWithCode(
  RangeError,
  'ERR_OUT_OF_RANGE',
  (str, range, input, replaceDefaultBoolean = false) => {
    let msg = replaceDefaultBoolean ? str :
      `The value of "${str}" is out of range.`;
    let received;
    if (NumberIsInteger(input) && MathAbs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) {
        received = addNumericalSeparator(received);
      }
      received += 'n';
    } else {
      received = lazyInspect(input);
    }
    msg += ` It must be ${range}. Received ${received}`;
    return msg;
  });

module.exports = {
  codes: {
    __proto__: null,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_INVALID_STATE,
    ERR_INVALID_THIS,
    ERR_OUT_OF_RANGE,
  },
};
