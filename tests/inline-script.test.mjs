import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('all inline browser scripts parse without syntax errors', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
    .map(([, , source]) => source.trim())
    .filter(Boolean);

  assert.ok(scripts.length > 0, 'expected at least one inline script');
  for (let index = 0; index < scripts.length; index += 1) {
    assert.doesNotThrow(
      () => new vm.Script(scripts[index], { filename: `public/index.html:inline-script-${index + 1}` }),
      `inline script ${index + 1} must parse`,
    );
  }
});
