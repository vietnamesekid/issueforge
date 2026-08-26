import { test } from 'node:test';
import assert from 'node:assert';
import { parsePair } from '../src/parse.js';

test('simple pair', () => {
  assert.deepEqual(parsePair('a=1'), { key: 'a', value: '1' });
});

test('value may contain "="', () => {
  assert.deepEqual(parsePair('a=b=c'), { key: 'a', value: 'b=c' });
  assert.deepEqual(parsePair('a==b'), { key: 'a', value: '=b' });
});
