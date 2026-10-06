'use strict';

const {
  ArrayPrototypeSlice,
  FunctionPrototypeCall,
  ObjectFreeze,
  SafeWeakRef,
} = require('../../primordials');

const { validateArray } = require('../../validators');
const {
  isProviderEnabled,
  validateProvider,
} = require('../objects');
const {
  getDispatchState,
  isDispatchable,
  registerAggregateProvider,
} = require('../dispatch');

/**
 * A provider that fans log events out to multiple providers.
 */
class AggregateProvider {
  #dispatchable;
  #providers;

  static {
    registerAggregateProvider(
      this.prototype.isEnabled,
      (provider) => #dispatchable in provider && provider.#dispatchable,
    );
  }

  constructor(providers) {
    validateArray(providers, 'providers');
    const copy = ArrayPrototypeSlice(providers);
    let dispatchable = true;
    for (let i = 0; i < copy.length; i++) {
      validateProvider(copy[i], `providers[${i}]`);
      dispatchable &&= isDispatchable(copy[i]);
    }
    this.#providers = ObjectFreeze(copy);
    this.#dispatchable = dispatchable;

    if (dispatchable) {
      // Re-resolve loggers using this aggregate whenever a member's
      // enablement changes. Members without isEnabled() never change.
      let ref;
      for (let i = 0; i < copy.length; i++) {
        const provider = copy[i];
        if (provider.isEnabled === undefined) continue;
        ref ??= new SafeWeakRef(this);
        // Duplicate members share the ref, so the SafeSet dedupes them.
        getDispatchState(provider).dependents.add(ref);
      }
    }
  }

  get providers() {
    return this.#providers;
  }

  isEnabled(level, context) {
    for (let i = 0; i < this.#providers.length; i++) {
      if (isProviderEnabled(this.#providers[i], level, context)) return true;
    }
    return false;
  }

  log(event, context) {
    for (let i = 0; i < this.#providers.length; i++) {
      const provider = this.#providers[i];
      if (isProviderEnabled(provider, event.level, context)) {
        FunctionPrototypeCall(provider.log, provider, event, context);
      }
    }
  }
}

module.exports = {
  AggregateProvider,
};
