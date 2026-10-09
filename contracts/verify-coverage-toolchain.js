'use strict';

// as-covers/glue does not declare its runtime glob dependency. Require the
// project's own installation so NODE_PATH or a parent project cannot hide it.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = createRequire(path.join(process.cwd(), 'package.json'));
const glue = createRequire(project.resolve('@as-covers/glue'));
const matcher = glue.resolve('micromatch');
assert.ok(matcher.startsWith(path.join(process.cwd(), 'node_modules') + path.sep),
  'Coverage must resolve its glob matcher from this contract project');

// Exercise the actual coverage filter, including exclusions, rather than only
// checking that the replacement matcher exports a similarly named function.
const { Covers } = project('@as-covers/glue');
const covers = new Covers({ files: project('./as-pect.config.js').coverage });
covers.registerLoader({ exports: { __getString: value => value } });
const files = [
  'assembly/index.ts',
  'assembly/credits-main.ts',
  'assembly/rewards-main.ts',
  'assembly/__tests__/contract.spec.ts',
  '~lib/index.ts',
  'node_modules/example/assembly/index.ts',
];
files.forEach((file, id) => covers.coverDeclare(file, id, 1, 1, 0));
assert.deepEqual([...covers.coverPoints.values()].map(point => point.file), files.slice(0, 3));
covers.cover(0);
assert.equal(covers.coverPoints.get(0).covered, true);
console.log('Contract coverage dependency and source filtering verified');
