import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the extracted browser application parses without syntax errors', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(source.trim().length > 0, 'expected the browser application source');
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: 'public/app.js' }),
    'browser application must parse',
  );
});

test('the HTML shell references the separated stylesheet and application', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i);
});


test('voice protection requires local Chinese recognition and an outbound audio delay', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /Speech\.available\(options\)/);
  assert.match(source, /Speech\.install\(options\)/);
  assert.match(source, /recognition\.processLocally=true/);
  assert.doesNotMatch(source, /processLocally\s*=\s*false/);
  assert.match(source, /createDelay\(2\)/);
  assert.match(source, /voiceDelay\.delayTime\.value=1\.6/);
  assert.match(source, /contact_voice_violation/);
  assert.match(source, /fetch\("\/api\/matchmaking"/);
  assert.doesNotMatch(source, /matchmaking_join|matchmaking_cancelled|match_waiting|match_found/);
  assert.match(source, /action===\"cancel\"\?8000:12000/);
  assert.match(source, /matchCancelling=true;clearInterval\(matchPoll\)/);
  assert.match(html, /不上传录音、不保存完整转写/);
});
