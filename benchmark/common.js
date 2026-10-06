'use strict';

// A small subset of the Node.js core benchmark harness API
// (benchmark/common.js), so that benchmarks can be shared with core.
//
//   const bench = createBenchmark(main, { n: [1e6], type: ['a', 'b'] });
//   function main({ n, type }) {
//     bench.start();
//     for (let i = 0; i < n; i++) work();
//     bench.end(n);
//   }
//
// Running a benchmark file runs every combination of the configuration
// values, each in a new process. Values can be restricted from the command
// line with `key=value` arguments, e.g. `node benchmark/enabled.js type=a`.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const kChildEnv = 'NODEJS_LOGGER_BENCHMARK_CHILD';
// When set, every benchmark runs with `n` = 10, to check that it works.
const smoke = process.env.NODEJS_LOGGER_BENCHMARK_SMOKE === '1';

function parseArgs(argv) {
  const values = { __proto__: null };
  for (const arg of argv) {
    const index = arg.indexOf('=');
    if (index === -1) throw new Error(`Invalid argument: ${arg}`);
    const key = arg.slice(0, index);
    (values[key] ??= []).push(arg.slice(index + 1));
  }
  return values;
}

function coerce(value, like) {
  return typeof like === 'number' ? Number(value) : value;
}

function combinations(configs) {
  let result = [{}];
  for (const key of Object.keys(configs)) {
    const next = [];
    for (const partial of result) {
      for (const value of configs[key]) {
        next.push({ ...partial, [key]: value });
      }
    }
    result = next;
  }
  return result;
}

function format(conf) {
  return Object.entries(conf).map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

class Benchmark {
  #main;
  #start;
  #name;

  constructor(main, configs, options = {}) {
    this.#main = main;
    this.#name = path.relative(__dirname, require.main.filename);
    const args = parseArgs(process.argv.slice(2));

    if (process.env[kChildEnv] === '1') {
      const conf = {};
      for (const key of Object.keys(configs)) {
        conf[key] = coerce(args[key][0], configs[key][0]);
      }
      if (smoke && 'n' in conf) conf.n = 10;
      process.nextTick(() => this.#main(conf));
      return;
    }

    const selected = { ...configs };
    for (const key of Object.keys(args)) {
      if (!(key in configs)) throw new Error(`Unknown option: ${key}`);
      selected[key] = args[key].map((value) => coerce(value, configs[key][0]));
    }
    for (const conf of combinations(selected)) {
      const result = spawnSync(process.execPath, [
        ...(options.flags ?? []),
        require.main.filename,
        ...Object.entries(conf).map(([key, value]) => `${key}=${value}`),
      ], {
        env: { ...process.env, [kChildEnv]: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        process.exitCode = 1;
        console.log(`${this.#name} ${format(conf)}: failed`);
        continue;
      }
      process.stdout.write(`${this.#name} ${format(conf)}: ${result.stdout}`);
    }
  }

  start() {
    this.#start = process.hrtime.bigint();
  }

  end(operations) {
    const elapsed = Number(process.hrtime.bigint() - this.#start);
    const rate = operations / (elapsed / 1e9);
    const nsPerOp = elapsed / operations;
    console.log(`${rate.toFixed(0).padStart(12)} ops/s ` +
                `(${nsPerOp.toFixed(2)} ns/op)`);
  }
}

function createBenchmark(main, configs, options) {
  return new Benchmark(main, configs, options);
}

module.exports = {
  createBenchmark,
  smoke,
};
