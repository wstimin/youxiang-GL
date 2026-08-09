'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCode, findAlias } = require('../src/extract');

test('extracts Chinese verification code', () => {
  assert.deepEqual(extractCode('', '你的验证码是：483921，十分钟内有效。', ''), {
    code: '483921', confidence: 100
  });
});

test('extracts English alphanumeric code', () => {
  assert.deepEqual(extractCode('Security notice', 'Your verification code: A7K9P2', ''), {
    code: 'A7K9P2', confidence: 100
  });
});

test('skips the connector in an English sentence', () => {
  assert.deepEqual(extractCode('', 'Your verification code is 778811 and expires soon.', ''), {
    code: '778811', confidence: 100
  });
});

test('does not treat a year as a generic code', () => {
  assert.equal(extractCode('', 'Invoice generated in 2026', ''), null);
});

test('matches an alias in raw headers', () => {
  const aliases = [{ id: 1, address: 'private-alias@example.com' }];
  assert.equal(findAlias('X-Original-To: private-alias@example.com', aliases).id, 1);
});

test('does not assign mail to an alias that is only an address substring', () => {
  const aliases = [
    { id: 1, address: 'a@example.com' },
    { id: 2, address: 'ba@example.com' }
  ];
  assert.equal(findAlias('Delivered-To: ba@example.com', aliases).id, 2);
});
