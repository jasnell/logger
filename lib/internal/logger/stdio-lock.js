'use strict';

// A lock shared by the threads of the process that write log records to
// stdout and stderr, so that each batch of records is written without
// interleaving with batches written by other threads.
//
// The lock lives in a SharedArrayBuffer published with setEnvironmentData()
// by the main thread, which every Worker created afterwards inherits,
// including nested workers. The key is versioned, so that only copies of this
// module that agree on the layout share a lock.
//
// A worker that did not inherit the lock (because it was created before the
// main thread loaded this module) cannot share one with the other threads.
// hasSharedStdioLock is then false, and ConsoleProvider writes through the
// worker's process.stdout and process.stderr instead, which Node.js forwards
// to the parent thread. Such a worker does not publish a lock either, so the
// workers it creates forward their output the same way.

// A single lock covers both stdout and stderr, since they often refer to the
// same pipe or terminal.
//
// Layout (Int32Array):
//   kState       0 if unlocked, otherwise the owner's threadId + 1.
//   kWaiters     The number of threads waiting for the lock.
//   kGeneration  Incremented on every acquisition.
//
// A thread can stop while it holds the lock, e.g. when worker.terminate()
// stops JavaScript execution. Rather than block forever, a thread that sees
// the same acquisition hold the lock for kMaxWaitMs takes it over. This can
// only cause interleaving if the owner is alive but has been blocked writing
// for that long, i.e. when the destination is not being read.

const {
  AtomicsAdd,
  AtomicsCompareExchange,
  AtomicsLoad,
  AtomicsNotify,
  AtomicsSub,
  AtomicsWait,
  DateNow,
  Int32Array,
  SharedArrayBuffer,
} = require('../primordials');

const {
  getEnvironmentData,
  isMainThread,
  setEnvironmentData,
  threadId,
} = require('node:worker_threads');
const { isSharedArrayBuffer } = require('node:util').types;

const kEnvironmentKey = 'nodejs.logger.stdioLock.v1';
const kState = 0;
const kWaiters = 1;
const kGeneration = 2;
const kByteLength = 16;
const kMaxWaitMs = 2000;
// Attempts to acquire a contended lock before blocking. Critical sections
// are usually a single write of a few microseconds, shorter than the cost of
// blocking and being woken up.
const kSpinCount = 2000;

function getSharedBuffer() {
  const inherited = getEnvironmentData(kEnvironmentKey);
  if (isSharedArrayBuffer(inherited) && inherited.byteLength >= kByteLength) {
    return inherited;
  }
  if (!isMainThread) return undefined;
  // Published when this module is loaded, so that workers created afterwards
  // inherit it, even if this thread has not logged yet.
  const buffer = new SharedArrayBuffer(kByteLength);
  setEnvironmentData(kEnvironmentKey, buffer);
  return buffer;
}

const sharedBuffer = getSharedBuffer();
const hasSharedStdioLock = sharedBuffer !== undefined;
// Without a shared lock, a private one keeps the same (reentrant) behavior.
const lock = new Int32Array(sharedBuffer ?? new SharedArrayBuffer(kByteLength));
const kOwner = threadId + 1;
// Acquisitions by this thread that have not been released. The lock is
// reentrant, since user code (e.g. 'write' listeners on a provider's stream)
// can run while it is held.
let depth = 0;

function acquireStdioLock() {
  if (depth++ > 0) return;
  if (AtomicsCompareExchange(lock, kState, 0, kOwner) !== 0) {
    waitForStdioLock();
  }
  AtomicsAdd(lock, kGeneration, 1);
}

function waitForStdioLock() {
  for (let i = 0; i < kSpinCount; i++) {
    if (AtomicsLoad(lock, kState) === 0 &&
        AtomicsCompareExchange(lock, kState, 0, kOwner) === 0) {
      return;
    }
  }
  AtomicsAdd(lock, kWaiters, 1);
  try {
    let generation = AtomicsLoad(lock, kGeneration);
    let deadline = DateNow() + kMaxWaitMs;
    for (;;) {
      const owner = AtomicsCompareExchange(lock, kState, 0, kOwner);
      if (owner === 0) return;
      const current = AtomicsLoad(lock, kGeneration);
      if (current !== generation) {
        // Another acquisition: the lock is not stuck.
        generation = current;
        deadline = DateNow() + kMaxWaitMs;
      }
      const remaining = deadline - DateNow();
      if (remaining <= 0) {
        // Presume the owner stopped while holding the lock.
        if (AtomicsCompareExchange(lock, kState, owner, kOwner) === owner) {
          return;
        }
        continue;
      }
      AtomicsWait(lock, kState, owner, remaining);
    }
  } finally {
    AtomicsSub(lock, kWaiters, 1);
  }
}

function releaseStdioLock() {
  if (--depth > 0) return;
  // Only release the lock if it was not taken over.
  if (AtomicsCompareExchange(lock, kState, kOwner, 0) === kOwner &&
      AtomicsLoad(lock, kWaiters) > 0) {
    AtomicsNotify(lock, kState, 1);
  }
}

module.exports = {
  acquireStdioLock,
  hasSharedStdioLock,
  kEnvironmentKey,
  kMaxWaitMs,
  releaseStdioLock,
};
