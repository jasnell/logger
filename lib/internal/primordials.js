'use strict';

// A minimal userland equivalent of Node.js core's `primordials`.
//
// Node.js core captures references to built-in functions and prototypes at
// startup so that internal code is not affected by user code that later
// modifies globals (e.g. `Array.prototype.push = ...`). This module does the
// same at module load time, and exposes the subset of primordials used by
// this package under the same names core uses. Keeping the names identical
// lets the code be vendored into Node.js core with minimal changes.
//
// The implementation of uncurryThis(), makeSafe() and the Safe* collections
// follows lib/internal/per_context/primordials.js in Node.js core.

const {
  defineProperty: ReflectDefineProperty,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
  ownKeys: ReflectOwnKeys,
} = Reflect;

// `uncurryThis` is equivalent to `func => Function.prototype.call.bind(func)`.
const { bind, call } = Function.prototype;
const uncurryThis = bind.bind(call);

const ArrayPrototypeForEach = uncurryThis(Array.prototype.forEach);
const FunctionPrototypeCall = uncurryThis(call);

const createSafeIterator = (factory, next) => {
  class SafeIterator {
    constructor(iterable) {
      this._iterator = factory(iterable);
    }
    next() {
      return next(this._iterator);
    }
    [Symbol.iterator]() {
      return this;
    }
  }
  Object.setPrototypeOf(SafeIterator.prototype, null);
  Object.freeze(SafeIterator.prototype);
  Object.freeze(SafeIterator);
  return SafeIterator;
};

const copyProps = (src, dest) => {
  ArrayPrototypeForEach(ReflectOwnKeys(src), (key) => {
    if (!ReflectGetOwnPropertyDescriptor(dest, key)) {
      ReflectDefineProperty(
        dest,
        key,
        { __proto__: null, ...ReflectGetOwnPropertyDescriptor(src, key) });
    }
  });
};

const makeSafe = (unsafe, safe, next) => {
  if (next) {
    const dummy = new unsafe();
    ArrayPrototypeForEach(ReflectOwnKeys(unsafe.prototype), (key) => {
      if (!ReflectGetOwnPropertyDescriptor(safe.prototype, key)) {
        const desc = ReflectGetOwnPropertyDescriptor(unsafe.prototype, key);
        if (
          typeof desc.value === 'function' &&
          desc.value.length === 0 &&
          FunctionPrototypeCall(desc.value, dummy)?.next === next
        ) {
          const createIterator = uncurryThis(desc.value);
          const SafeIterator = createSafeIterator(createIterator, next);
          desc.value = function() {
            return new SafeIterator(this);
          };
        }
        ReflectDefineProperty(safe.prototype, key, { __proto__: null, ...desc });
      }
    });
  } else {
    copyProps(unsafe.prototype, safe.prototype);
  }
  copyProps(unsafe, safe);

  Object.setPrototypeOf(safe.prototype, null);
  Object.freeze(safe.prototype);
  Object.freeze(safe);
  return safe;
};

const MapIteratorPrototypeNext =
  uncurryThis(Object.getPrototypeOf(new Map().entries()).next);
const SetIteratorPrototypeNext =
  uncurryThis(Object.getPrototypeOf(new Set().values()).next);

const SafeMap = makeSafe(
  Map,
  class SafeMap extends Map {},
  MapIteratorPrototypeNext,
);
const SafeSet = makeSafe(
  Set,
  class SafeSet extends Set {},
  SetIteratorPrototypeNext,
);
const SafeWeakMap = makeSafe(
  WeakMap,
  class SafeWeakMap extends WeakMap {},
);
const SafeWeakRef = makeSafe(
  WeakRef,
  class SafeWeakRef extends WeakRef {},
);

const primordials = {
  __proto__: null,

  uncurryThis,

  ArrayIsArray: Array.isArray,
  ArrayPrototypeIncludes: uncurryThis(Array.prototype.includes),
  ArrayPrototypeIndexOf: uncurryThis(Array.prototype.indexOf),
  ArrayPrototypeJoin: uncurryThis(Array.prototype.join),
  ArrayPrototypeMap: uncurryThis(Array.prototype.map),
  ArrayPrototypePop: uncurryThis(Array.prototype.pop),
  ArrayPrototypePush: uncurryThis(Array.prototype.push),
  ArrayPrototypeSlice: uncurryThis(Array.prototype.slice),
  ArrayPrototypeSplice: uncurryThis(Array.prototype.splice),
  DateNow: Date.now,
  Error,
  ErrorCaptureStackTrace: Error.captureStackTrace,
  ErrorIsError: Error.isError,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance:
    uncurryThis(Function.prototype[Symbol.hasInstance]),
  JSONStringify: JSON.stringify,
  MathAbs: Math.abs,
  NumberIsFinite: Number.isFinite,
  NumberIsInteger: Number.isInteger,
  NumberMAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  ObjectAssign: Object.assign,
  ObjectDefineProperties: Object.defineProperties,
  ObjectDefineProperty: Object.defineProperty,
  ObjectFreeze: Object.freeze,
  ObjectGetOwnPropertySymbols: Object.getOwnPropertySymbols,
  ObjectGetPrototypeOf: Object.getPrototypeOf,
  ObjectKeys: Object.keys,
  ObjectPrototypeHasOwnProperty: uncurryThis(Object.prototype.hasOwnProperty),
  ObjectPrototypePropertyIsEnumerable:
    uncurryThis(Object.prototype.propertyIsEnumerable),
  ObjectSetPrototypeOf: Object.setPrototypeOf,
  RangeError,
  ReflectApply: Reflect.apply,
  ReflectOwnKeys,
  RegExpPrototypeExec: uncurryThis(RegExp.prototype.exec),
  SafeMap,
  SafeSet,
  SafeWeakMap,
  SafeWeakRef,
  String,
  StringPrototypeCharCodeAt: uncurryThis(String.prototype.charCodeAt),
  StringPrototypeEndsWith: uncurryThis(String.prototype.endsWith),
  StringPrototypeIncludes: uncurryThis(String.prototype.includes),
  StringPrototypeIndexOf: uncurryThis(String.prototype.indexOf),
  StringPrototypeSlice: uncurryThis(String.prototype.slice),
  StringPrototypeToLowerCase: uncurryThis(String.prototype.toLowerCase),
  Symbol,
  SymbolFor: Symbol.for,
  TypeError,
};

module.exports = Object.freeze(primordials);
