'use strict';

// Runs every benchmark, or those given as arguments.
//
//   node benchmark/run.js [name...]

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const exclude = new Set(['common.js', 'run.js']);
const names = process.argv.length > 2 ?
  process.argv.slice(2).map((name) => name.replace(/(\.js)?$/, '.js')) :
  readdirSync(__dirname).filter((name) => name.endsWith('.js') &&
                                          !exclude.has(name));

for (const name of names) {
  const { status } = spawnSync(process.execPath, [path.join(__dirname, name)],
                               { stdio: 'inherit' });
  if (status !== 0) process.exitCode = 1;
}
