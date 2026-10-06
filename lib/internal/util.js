'use strict';

// A subset of Node.js core's internal/util.

const {
  Error,
  ErrorIsError,
  FunctionPrototypeSymbolHasInstance,
  ObjectFreeze,
} = require('./primordials');

const kEmptyObject = ObjectFreeze({ __proto__: null });

// Same semantics as core's isError(): native errors, including those from
// other realms, and objects that inherit from Error. `Error.isError()` is
// the standard replacement for the deprecated `util.types.isNativeError()`.
function isError(e) {
  return ErrorIsError(e) || FunctionPrototypeSymbolHasInstance(Error, e);
}

module.exports = {
  isError,
  kEmptyObject,
};
