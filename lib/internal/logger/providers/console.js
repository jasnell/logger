'use strict';

const {
  AtomicsWait,
  FunctionPrototypeCall,
  Int32Array,
  MathMin,
  ObjectAssign,
  SafeSet,
  SharedArrayBuffer,
} = require('../../primordials');

const {
  codes: {
    ERR_INVALID_RETURN_VALUE,
  },
} = require('../../errors');
const {
  validateBoolean,
  validateFunction,
  validateInteger,
  validateObject,
  validateOneOf,
} = require('../../validators');
const { kEmptyObject } = require('../../util');
const { Buffer } = require('node:buffer');
const { isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
const { Utf8Stream } = fs;
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
const {
  acquireStdioLock,
  hasSharedStdioLock,
  releaseStdioLock,
} = require('../stdio-lock');

const kDestinations = ['stdout', 'stderr'];

// Writing
//
// Records are buffered in a synchronous Utf8Stream, and written with
// flushSync() while holding the stdio lock shared by all threads (see
// stdio-lock.js), so that batches of records written by different threads
// never interleave. Since every write happens synchronously inside
// flushSync(), including partial writes and EAGAIN retries, the lock covers
// the whole batch.
//
// - By default, records are written at the end of the current turn of the
//   event loop (setImmediate()), or as soon as kBatchLength characters are
//   buffered.
// - With `sync`, every record is written immediately.
// - With `minLength`, records are buffered until at least `minLength`
//   characters are, with no flush at the end of the turn.
//
// Pending records are written when the process (or worker) exits, and
// records logged during 'exit' listeners are written immediately.
//
// The stream's own automatic writes are effectively disabled (minLength just
// below maxWrite), so that every write happens under the lock. It never has
// an asynchronous write in progress, so flushSync() can always be used.

// Buffered characters that trigger a flush by default. Larger batches are
// slightly cheaper for files, but writes of a pipe's whole capacity (64 KiB
// on Linux) stop overlapping with the reader, which is much slower.
const kBatchLength = 32 * 1024;
const kStreamMaxWrite = 1024 * 1024;
const kStreamMinLength = kStreamMaxWrite - 1;
const kMaxMinLength = kStreamMinLength - 1;
const kMaxUint32 = 2 ** 32 - 1;

function noop() {}

// Backoff when a write fails with EAGAIN, in milliseconds.
const kMinRetryDelay = 0.05;
const kMaxRetryDelay = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// Writes until at least one byte is written. stdout and stderr are
// non-blocking when they are pipes and the main thread has used
// process.stdout or created a Worker (which pipes the worker's stdout to it),
// so writes fail with EAGAIN while the pipe is full. Utf8Stream would then
// sleep for 100 ms before retrying, while holding the stdio lock. Since
// fs.writeSync() reports partial writes rather than EAGAIN, retrying here
// never writes anything twice.
//
// Other errors are not thrown: Utf8Stream's flushSync() retries every error
// forever (sleeping 100 ms in between), so e.g. EPIPE would hang the thread.
// Instead, the data is reported as written, discarding it, and the first
// error is thrown by flushStream() once flushSync() returns.
let writeError = null;

function writeSync(fd, data, encoding) {
  if (isMainThread && hasPendingStdioWrites()) {
    return forwardSync(fd, data, encoding);
  }
  let delay = kMinRetryDelay;
  for (;;) {
    try {
      return fs.writeSync(fd, data, encoding);
    } catch (err) {
      if (err?.code !== 'EAGAIN') {
        writeError ??= err;
        return typeof data === 'string' ?
          Buffer.byteLength(data, encoding) : data.byteLength;
      }
      AtomicsWait(sleepCell, 0, 0, delay);
      delay = MathMin(delay * 2, kMaxRetryDelay);
    }
  }
}

// Writes the records buffered in `stream`, holding the stdio lock. Records
// that could not be written are discarded, and the error is thrown.
function flushStream(stream) {
  acquireStdioLock();
  let error;
  try {
    stream.flushSync();
  } finally {
    error = writeError;
    writeError = null;
    releaseStdioLock();
  }
  if (error !== null) throw error;
}

// In a worker that does not share the stdio lock with the other threads
// (see stdio-lock.js), batches are written through process.stdout or
// process.stderr, which forward them to the parent thread, where they are
// written in order with those of other threads.
function forwardSync(fd, data, encoding) {
  (fd === 1 ? process.stdout : process.stderr).write(data, encoding);
  return typeof data === 'string' ?
    Buffer.byteLength(data, encoding) : data.byteLength;
}

// In the main thread, process.stdout and process.stderr may have pending
// asynchronous writes: output forwarded from workers that do not share the
// stdio lock, or from console.log(). Writing to the file descriptor directly
// could then split their data, so batches are queued after them instead.
// libuv only writes from this thread, between turns of the event loop, so
// nothing can start writing between this check and a direct write.
function hasPendingStdioWrites() {
  return process.stdout.writableLength > 0 ||
    process.stderr.writableLength > 0;
}

// Utf8Stream calls fsyncSync() after flushSync(), which would make every
// flush very slow when stdout is redirected to a file.
const kStreamFs = {
  __proto__: null,
  fsyncSync: noop,
  writeSync: hasSharedStdioLock ? writeSync : forwardSync,
};

// Providers with buffered records.
const pendingProviders = new SafeSet();
let flushScheduled = false;
let exitHookInstalled = false;
// Set once the process emits 'exit': records are then written immediately.
let exiting = false;
// Set in ConsoleProvider's static block.
let flushPending;

function flushScheduledProviders() {
  flushScheduled = false;
  for (const provider of pendingProviders) {
    flushPending(provider, false);
  }
}

function onExit() {
  exiting = true;
  for (const provider of pendingProviders) {
    flushPending(provider, true);
  }
}

/**
 * A provider that writes newline-delimited JSON to stdout or stderr.
 */
class ConsoleProvider {
  // Characters written to the stream since the last flush.
  #buffered = 0;
  #destination;
  #flatten;
  // Whether to flush at the end of the turn of the event loop.
  #flushOnTurn;
  #level;
  // Characters that can be buffered without the stream dropping records.
  #limit;
  #pid;
  #pidJSON;
  #serializer;
  #stream;
  #sync;
  // Buffered characters that trigger a flush.
  #threshold;

  static {
    registerObservableIsEnabled(this.prototype.isEnabled);
    flushPending = (provider, atExit) => {
      if (atExit || provider.#flushOnTurn) provider.#flushPending(atExit);
    };
  }

  constructor(options = kEmptyObject) {
    validateObject(options, 'options');
    const {
      destination = 'stdout',
      flatten = false,
      level = 'info',
      maxLength = 0,
      minLength = 0,
      periodicFlush = 0,
      pid = false,
      serializer = defaultSerializer,
      sync = false,
    } = options;

    validateOneOf(destination, 'options.destination', kDestinations);
    validateBoolean(flatten, 'options.flatten');
    validateInteger(maxLength, 'options.maxLength', 0, kMaxUint32);
    validateInteger(minLength, 'options.minLength', 0, kMaxMinLength);
    validateInteger(periodicFlush, 'options.periodicFlush', 0, kMaxUint32);
    validateBoolean(pid, 'options.pid');
    validateFunction(serializer, 'options.serializer');
    validateBoolean(sync, 'options.sync');
    this.#destination = destination;
    this.#flatten = flatten;
    this.#level = normalizeThreshold(level, 'options.level');
    this.#pid = pid;
    this.#pidJSON = pid ? `,"pid":${process.pid}` : '';
    this.#serializer = serializer;
    this.#sync = sync;

    this.#threshold = minLength > 0 ? minLength : (sync ? 0 : kBatchLength);
    this.#limit = maxLength > 0 ? maxLength : Infinity;
    this.#flushOnTurn = !sync && minLength === 0;

    // Installed before any record is logged: listeners added while 'exit' is
    // emitted would not be called.
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on('exit', onExit);
    }

    this.#stream = new Utf8Stream({
      // Creating the logger is not a hotpath... it's ok for the options
      // to be passed in dictionary mode rather than fast properties mode.
      __proto__: null,
      fd: destination === 'stdout' ? 1 : 2,
      fs: kStreamFs,
      maxLength,
      maxWrite: kStreamMaxWrite,
      minLength: kStreamMinLength,
      sync: true,
    });

    if (periodicFlush > 0) {
      // Does not keep a reference to the provider, so that it can be
      // collected along with the timer.
      const stream = this.#stream;
      const timer = setInterval(() => {
        try {
          flushStream(stream);
        } catch (err) {
          stream.emit('error', err);
        }
      }, periodicFlush);
      timer.unref();
    }
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
          this.#write(serialized);
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
      this.#write(`${serialized}\n`);
    }
  }

  #write(data) {
    if (this.#buffered + data.length > this.#limit) {
      // Flush first, so that the stream does not drop the record if it fits
      // in maxLength by itself.
      this.#flushOrReport();
    }
    this.#stream.write(data);
    this.#buffered += data.length;
    if (this.#buffered >= this.#threshold || exiting) {
      this.#flushOrReport();
    } else if (this.#buffered === data.length) {
      // First record since the last flush.
      this.#schedule();
    }
  }

  #flushOrReport() {
    try {
      this.#flush();
    } catch (err) {
      this.#reportError(err);
    }
  }

  #schedule() {
    pendingProviders.add(this);
    if (this.#flushOnTurn && !flushScheduled) {
      flushScheduled = true;
      setImmediate(flushScheduledProviders);
    }
  }

  #flush() {
    if (this.#buffered === 0) return;
    this.#buffered = 0;
    pendingProviders.delete(this);
    flushStream(this.#stream);
  }

  #flushPending(atExit) {
    try {
      this.#flush();
    } catch (err) {
      // Nothing can be done about write errors at exit.
      if (!atExit) this.#reportError(err);
    }
  }

  // Write errors are reported as 'error' events on the stream, like
  // Utf8Stream does: synchronously with `sync`, otherwise asynchronously.
  #reportError(err) {
    if (this.#sync) {
      this.#stream.emit('error', err);
    } else {
      process.nextTick(() => this.#stream.emit('error', err));
    }
  }

  flush(callback) {
    if (callback !== undefined) validateFunction(callback, 'callback');
    let error = null;
    try {
      this.#flush();
    } catch (err) {
      error = err;
    }
    if (callback !== undefined) {
      process.nextTick(callback, error);
    } else if (error !== null) {
      this.#reportError(error);
    }
  }

  flushSync() {
    this.#flush();
  }
}

module.exports = {
  ConsoleProvider,
};
