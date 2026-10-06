'use strict';

const { validateObject } = require('../../validators');
const { kEmptyObject } = require('../../util');
const EventEmitter = require('node:events');
const { normalizeThreshold } = require('../objects');
const {
  invalidateDispatch,
  registerObservableIsEnabled,
} = require('../dispatch');

/**
 * An EventEmitter that receives structured log events.
 */
class EventProvider extends EventEmitter {
  #level;

  static {
    registerObservableIsEnabled(this.prototype.isEnabled);
  }

  constructor(options = kEmptyObject) {
    validateObject(options, 'options');
    const { level = 'trace' } = options;
    const normalizedLevel = normalizeThreshold(level, 'options.level');

    super();
    this.#level = normalizedLevel;
  }

  get level() {
    return this.#level;
  }

  set level(level) {
    this.#level = normalizeThreshold(level);
    invalidateDispatch(this);
  }

  isEnabled(level) {
    return level.value >= this.#level.value;
  }

  log(event) {
    if (this.isEnabled(event.level)) {
      const eventName = event.level.name;
      this.emit(this.listenerCount(eventName) > 0 ? eventName : 'log', event);
    }
  }
}

module.exports = {
  EventProvider,
};
