'use strict';

const {
  FunctionPrototypeCall,
  ObjectAssign,
} = require('../../primordials');

const {
  codes: {
    ERR_INVALID_RETURN_VALUE,
  },
} = require('../../errors');
const {
  validateBoolean,
  validateFunction,
  validateObject,
  validateOneOf,
} = require('../../validators');
const { kEmptyObject } = require('../../util');
const { Utf8Stream } = require('node:fs');
const {
  NullPrototypeObject,
  normalizeThreshold,
} = require('../objects');
const {
  invalidateDispatch,
  registerObservableIsEnabled,
} = require('../dispatch');
const {
  defaultSerializer,
  serializeEventFast,
} = require('../serializer');

const kDestinations = ['stdout', 'stderr'];

/**
 * A provider that writes newline-delimited JSON to stdout or stderr.
 */
class ConsoleProvider {
  #destination;
  #flatten;
  #level;
  #pid;
  #pidJSON;
  #serializer;
  #stream;

  static {
    registerObservableIsEnabled(this.prototype.isEnabled);
  }

  constructor(options = kEmptyObject) {
    validateObject(options, 'options');
    const {
      destination = 'stdout',
      flatten = false,
      level = 'info',
      maxLength,
      minLength,
      periodicFlush,
      pid = false,
      serializer = defaultSerializer,
      sync,
    } = options;

    validateOneOf(destination, 'options.destination', kDestinations);
    validateBoolean(flatten, 'options.flatten');
    validateBoolean(pid, 'options.pid');
    validateFunction(serializer, 'options.serializer');
    this.#destination = destination;
    this.#flatten = flatten;
    this.#level = normalizeThreshold(level, 'options.level');
    this.#pid = pid;
    this.#pidJSON = pid ? `,"pid":${process.pid}` : '';
    this.#serializer = serializer;
    this.#stream = new Utf8Stream({
      // Creating the logger is not a hotpath... it's ok for the options
      // to be passed in dictionary mode rather than fast properties mode.
      __proto__: null,
      fd: destination === 'stdout' ? 1 : 2,
      maxLength,
      minLength,
      periodicFlush,
      sync,
    });
  }

  get destination() {
    return this.#destination;
  }

  get flatten() {
    return this.#flatten;
  }

  get level() {
    return this.#level;
  }

  set level(level) {
    this.#level = normalizeThreshold(level);
    invalidateDispatch(this);
  }

  get pid() {
    return this.#pid;
  }

  get serializer() {
    return this.#serializer;
  }

  get stream() {
    return this.#stream;
  }

  isEnabled(level) {
    return level.value >= this.#level.value;
  }

  log(event, context) {
    if (this.isEnabled(event.level)) {
      if (this.#serializer === defaultSerializer) {
        const serialized =
          serializeEventFast(event, context, this.#flatten, this.#pidJSON);
        if (serialized !== undefined) {
          this.#stream.write(serialized);
          return;
        }
      }
      let record = event;
      if (this.#flatten || this.#pid) {
        const withPid = this.#pid ? { pid: process.pid } : null;
        record = new NullPrototypeObject();
        if (this.#flatten) {
          record = ObjectAssign(
            record,
            event.bindings,
            event.attributes,
            {
              level: event.level.value,
              levelName: event.level.name,
              message: event.message,
              name: event.name,
              timestamp: event.timestamp,
            },
            withPid,
          );
        } else {
          record = ObjectAssign(record, event, withPid);
        }
      }
      const serialized = FunctionPrototypeCall(
        this.#serializer,
        undefined,
        record,
      );
      if (typeof serialized !== 'string') {
        throw new ERR_INVALID_RETURN_VALUE(
          'a string',
          'serializer',
          serialized,
        );
      }
      this.#stream.write(`${serialized}\n`);
    }
  }

  flush(callback) {
    this.#stream.flush(callback);
  }

  flushSync() {
    this.#stream.flushSync();
  }
}

module.exports = {
  ConsoleProvider,
};
