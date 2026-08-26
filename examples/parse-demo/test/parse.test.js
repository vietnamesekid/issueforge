import { test } from 'node:test';
import assert from 'node:assert';
import { parsePair } from '../src/parse.js';

test('simple pair', () => {
  assert.deepEqual(parsePair('a=1'), { key: 'a', value: '1' });
});

test('value containing = is kept whole', () => {
  assert.deepEqual(parsePair('url=http://x?a=1'), {
    key: 'url',
    value: 'http://x?a=1',
  });
});
