import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const baseline = fileURLToPath(new URL('../baseline.mjs', import.meta.url));

test('the baseline clone CLI rejects a primary database destination', () => {
  const result = spawnSync(process.execPath, [baseline, 'clone', 'capstone-postgres'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing non-recovery target/);
});
