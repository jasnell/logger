'use strict';

// Level method dispatch
//
// When a provider's enablement can only change through paths this module
// observes, the per-level methods (`trace()`, `debug()`, etc.) are resolved
// ahead of time instead of checking `isEnabled()` on every call. Disabled
// levels are bound to a shared empty function, which the JIT can inline away
// entirely at monomorphic call sites (the same technique pino uses).
//
// The resolved methods live on a dispatch prototype that is shared by every
// logger with the same provider and the same logger prototype. Re-resolving
// after a level change therefore updates a single object, rather than having
// to track every logger instance (child loggers are often created per
// request).
//
// Providers whose enablement may change without notice (a custom
// `isEnabled()`) keep the per-call `isEnabled()` check.
//
// The Logger class and AggregateProvider register themselves with this
// module when they are defined (see registerLogger() and
// registerAggregateProvider()), and built-in providers register their
// isEnabled() implementations (see registerObservableIsEnabled()).

const {
  ObjectDefineProperty,
  ObjectPrototypeHasOwnProperty,
  ObjectSetPrototypeOf,
  SafeMap,
  SafeSet,
  SafeWeakMap,
} = require('../primordials');

const {
  isProviderEnabled,
  kLevelNames,
  levels,
} = require('./objects');

function noop() {}

// Set by registerLogger(): level name -> the real (checking)
// Logger.prototype method, and the function that creates the Logger subclass
// for a dispatch prototype.
let kLevelMethods;
let createDispatchClass;
// Set by registerAggregateProvider().
let aggregateIsEnabled;
let isAggregateDispatchable;

// Built-in isEnabled() implementations whose result only changes through a
// level setter that calls invalidateDispatch().
const kObservableIsEnabled = new SafeSet();

// provider -> { prototypes: SafeMap<base, dispatch>, dependents: SafeSet }
const dispatchStates = new SafeWeakMap();
// Maps dispatch prototype -> { provider, base, target }, where `target` is
// the generated Logger subclass whose prototype is the dispatch object, or
// undefined for dispatch objects of other bases.
const dispatchInfo = new SafeWeakMap();

/**
 * Registers the Logger class.
 * @param {object} levelMethods Level name -> the Logger.prototype method.
 * @param {(base: object) => Function|undefined} createClass Returns a new
 *   Logger subclass to use for dispatch prototypes of `base`, or undefined
 *   if `base` is not Logger.prototype.
 */
function registerLogger(levelMethods, createClass) {
  kLevelMethods = levelMethods;
  createDispatchClass = createClass;
}

/**
 * Registers AggregateProvider, whose enablement is observable when all of
 * its members' is.
 * @param {Function} isEnabled AggregateProvider.prototype.isEnabled.
 * @param {(provider: object) => boolean} isDispatchable Returns whether an
 *   AggregateProvider only has dispatchable members.
 */
function registerAggregateProvider(isEnabled, isDispatchable) {
  aggregateIsEnabled = isEnabled;
  isAggregateDispatchable = isDispatchable;
}

/**
 * Registers a built-in isEnabled() implementation whose result only changes
 * when the provider calls invalidateDispatch().
 * @param {Function} isEnabled
 */
function registerObservableIsEnabled(isEnabled) {
  kObservableIsEnabled.add(isEnabled);
}

function getDispatchState(provider) {
  let state = dispatchStates.get(provider);
  if (state === undefined) {
    state = {
      prototypes: new SafeMap(),
      // WeakRefs to aggregate providers that must be re-resolved when this
      // provider's enablement changes.
      dependents: new SafeSet(),
    };
    dispatchStates.set(provider, state);
  }
  return state;
}

/**
 * Returns the `{ provider, base, target }` information of a dispatch
 * prototype, or undefined if `proto` is not one.
 * @param {object} proto
 * @returns {object|undefined}
 */
function getDispatchInfo(proto) {
  return dispatchInfo.get(proto);
}

/**
 * Returns whether every change to the provider's enablement is observed by
 * this module, making it safe to resolve level methods ahead of time.
 * @param {object} provider
 * @returns {boolean}
 */
function isDispatchable(provider) {
  const isEnabled = provider.isEnabled;
  return isEnabled === undefined ||
    kObservableIsEnabled.has(isEnabled) ||
    (isEnabled === aggregateIsEnabled && isAggregateDispatchable(provider));
}

function resolveDispatchPrototype(provider, dispatch) {
  for (let i = 0; i < kLevelNames.length; i++) {
    const name = kLevelNames[i];
    // Level methods overridden by a Logger subclass are not managed.
    if (!ObjectPrototypeHasOwnProperty(dispatch, name)) continue;
    // Built-in dispatchable providers do not depend on the logger context.
    const method = isProviderEnabled(provider, levels[name], undefined) ?
      kLevelMethods[name] : noop;
    // Avoid needless writes, which invalidate optimized code.
    if (dispatch[name] !== method) dispatch[name] = method;
  }
}

/**
 * Returns the dispatch prototype for loggers using `provider` whose prototype
 * would otherwise be `base`, or `undefined` if level methods must check the
 * provider on every call.
 * @param {object} provider
 * @param {object} base
 * @returns {object|undefined}
 */
function getDispatchPrototype(provider, base) {
  // Without isEnabled() every level is always enabled, so the regular
  // prototype methods are already the right ones.
  if (provider.isEnabled === undefined || !isDispatchable(provider)) {
    return undefined;
  }
  const state = getDispatchState(provider);
  let dispatch = state.prototypes.get(base);
  if (dispatch === undefined) {
    // For plain loggers, the dispatch prototype is the prototype of a
    // generated Logger subclass, so that create() and child() can allocate
    // loggers with it directly using `new`. (Changing the prototype of an
    // existing object, and ReflectConstruct() with another new.target, are
    // both much slower.) Other bases only get the prototype swapped in.
    const target = createDispatchClass(base);
    dispatch = target === undefined ? { __proto__: base } : target.prototype;
    for (let i = 0; i < kLevelNames.length; i++) {
      const name = kLevelNames[i];
      if (base[name] !== kLevelMethods[name]) continue;
      const desc = {
        configurable: true,
        enumerable: false,
        value: noop,
        writable: true,
      };
      ObjectSetPrototypeOf(desc, null);
      ObjectDefineProperty(dispatch, name, desc);
    }
    resolveDispatchPrototype(provider, dispatch);
    state.prototypes.set(base, dispatch);
    dispatchInfo.set(dispatch, {
      __proto__: null,
      base,
      provider,
      target,
    });
  }
  return dispatch;
}

/**
 * Re-resolves level methods for all loggers using `provider`, and for all
 * aggregate providers that include it. Must be called whenever the result of
 * a dispatchable provider's isEnabled() may have changed.
 * @param {object} provider
 */
function invalidateDispatch(provider) {
  const state = dispatchStates.get(provider);
  if (state === undefined) return;
  for (const dispatch of state.prototypes.values()) {
    resolveDispatchPrototype(provider, dispatch);
  }
  for (const ref of state.dependents) {
    const dependent = ref.deref();
    if (dependent === undefined) {
      state.dependents.delete(ref);
    } else {
      invalidateDispatch(dependent);
    }
  }
}

module.exports = {
  getDispatchInfo,
  getDispatchPrototype,
  getDispatchState,
  invalidateDispatch,
  isDispatchable,
  registerAggregateProvider,
  registerLogger,
  registerObservableIsEnabled,
};
