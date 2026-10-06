'use strict';

// End-to-end cost of ConsoleProvider with real I/O, from one or more threads
// writing to the same stdout. Unlike the other benchmarks, this one includes
// the cost of the writes themselves, and of the work done off the main
// thread (process CPU time includes the libuv threadpool).
//
//   node benchmark/console-io.js [key=value...]
//
// Options (each accepts a comma-separated list):
//   logger   node-logger, pino (pino.destination() with the same `sync`)
//   target   devnull; file; pipe (a shell pipe into `cat`, which writes to a
//            file; not on Windows); socket (the parent process reads the
//            child's stdout, which Node.js creates as a socket pair)
//   mode     async, sync (the ConsoleProvider `sync` option)
//   workers  number of worker threads logging; 0 logs from the main thread
//   size     bytes of padding per record
//   preload  1 to load the module in the main thread before creating
//            workers (which lets them share the stdio lock), or 0
//   n        total records, split between the logging threads
//   runs     runs per configuration (the median is reported)
//   lib      path of the module to benchmark (default: this package)
//
// For the file and pipe targets, every line is parsed to detect records
// corrupted by concurrent writes.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const smoke = process.env.NODEJS_LOGGER_BENCHMARK_SMOKE === '1';

const defaults = {
  logger: ['node-logger'],
  target: ['devnull', 'file', 'pipe', 'socket'],
  mode: ['async', 'sync'],
  workers: ['0', '4'],
  size: ['50', '2000'],
  preload: ['1'],
  n: ['200000'],
  runs: ['3'],
  lib: [path.resolve(__dirname, '..')],
};

function childMain(config) {
  const { Worker, isMainThread, workerData } = require('node:worker_threads');
  const { lib, mode, workers, size, n } = config;

  function logRecords(count) {
    if (config.logger === 'pino') {
      const pino = require('pino');
      const destination = pino.destination({ dest: 1, sync: mode === 'sync' });
      const logger = pino({ base: null, name: 'bench' }, destination);
      const pad = 'x'.repeat(size);
      for (let i = 0; i < count; i++) logger.info({ i, pad }, 'message');
      return;
    }
    const { ConsoleProvider, create } = require(lib);
    const provider = new ConsoleProvider({ sync: mode === 'sync', flatten: true });
    const logger = create(provider, { name: 'bench' });
    const pad = 'x'.repeat(size);
    for (let i = 0; i < count; i++) logger.info('message', { i, pad });
  }

  if (!isMainThread) {
    logRecords(workerData);
    return;
  }

  const start = process.hrtime.bigint();
  process.on('exit', () => {
    const wall = Number(process.hrtime.bigint() - start) / 1e6;
    const { user, system } = process.cpuUsage();
    fs.writeSync(2, `${JSON.stringify({ wall, cpu: (user + system) / 1e3 })}\n`);
  });

  if (workers === 0) {
    logRecords(n);
  } else {
    if (config.preload && config.logger === 'node-logger') require(lib);
    for (let i = 0; i < workers; i++) {
      new Worker(__filename, {
        argv: ['--child', JSON.stringify(config)],
        workerData: Math.floor(n / workers),
      });
    }
  }
}

function countCorrupted(text) {
  let bad = 0;
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    lines++;
    try {
      JSON.parse(line);
    } catch {
      bad++;
    }
  }
  return { bad, lines };
}

function runOnce(config) {
  return new Promise((resolve, reject) => {
    let stdout;
    let file;
    const args = [__filename, '--child', JSON.stringify(config)];
    let command = process.execPath;
    if (config.target === 'devnull') {
      stdout = fs.openSync(os.devNull, 'w');
    } else if (config.target === 'file' || config.target === 'pipe') {
      file = path.join(os.tmpdir(), `nodejs-logger-io-${process.pid}.log`);
      if (config.target === 'file') {
        stdout = fs.openSync(file, 'w');
      } else {
        const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
        args.splice(0, args.length, '-c',
                    `${[process.execPath, ...args].map(quote).join(' ')} | ` +
                    `cat > ${quote(file)}`);
        command = '/bin/sh';
        stdout = 'ignore';
      }
    } else {
      stdout = 'pipe';
    }
    const child = spawn(command, args, { stdio: ['ignore', stdout, 'pipe'] });
    if (typeof stdout === 'number') fs.closeSync(stdout);
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with ${code}: ${stderr}`));
        return;
      }
      const result = JSON.parse(stderr.trim().split('\n').pop());
      let text;
      if (file !== undefined) {
        text = fs.readFileSync(file, 'utf8');
        fs.rmSync(file);
      } else if (config.target === 'socket') {
        text = Buffer.concat(chunks).toString('utf8');
      }
      if (text !== undefined) Object.assign(result, countCorrupted(text));
      resolve(result);
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function combinations(options) {
  let result = [{}];
  for (const key of ['logger', 'target', 'mode', 'workers', 'size', 'preload']) {
    const next = [];
    for (const partial of result) {
      for (const value of options[key]) next.push({ ...partial, [key]: value });
    }
    result = next;
  }
  return result;
}

async function main() {
  const options = { ...defaults };
  for (const arg of process.argv.slice(2)) {
    const index = arg.indexOf('=');
    const key = arg.slice(0, index);
    if (index === -1 || !(key in defaults)) {
      throw new Error(`Invalid argument: ${arg}`);
    }
    options[key] = arg.slice(index + 1).split(',');
  }
  if (smoke) {
    options.n = ['100'];
    options.runs = ['1'];
  }
  const n = Number(options.n[0]);
  const runs = Number(options.runs[0]);
  const lib = path.resolve(options.lib[0]);

  for (const combination of combinations(options)) {
    const config = {
      ...combination,
      workers: Number(combination.workers),
      size: Number(combination.size),
      preload: combination.preload === '1',
      n,
      lib,
    };
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await runOnce(config));
    const wall = median(results.map((r) => r.wall));
    const cpu = median(results.map((r) => r.cpu));
    const rate = n / (wall / 1e3);
    let line = `console-io.js logger=${config.logger} ` +
      `target=${config.target} mode=${config.mode} ` +
      `workers=${config.workers} size=${config.size}` +
      `${config.workers > 0 && config.logger === 'node-logger' ?
        ` preload=${Number(config.preload)}` : ''}: ` +
      `${rate.toFixed(0).padStart(9)} records/s ` +
      `wall ${wall.toFixed(0)} ms cpu ${cpu.toFixed(0)} ms`;
    if (results[0].lines !== undefined) {
      const bad = Math.max(...results.map((r) => r.bad));
      const lines = Math.min(...results.map((r) => r.lines));
      line += ` lines ${lines} corrupted ${bad}`;
    }
    console.log(line);
  }
}

if (process.argv[2] === '--child') {
  childMain(JSON.parse(process.argv[3]));
} else {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
