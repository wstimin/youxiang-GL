'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBodyText, extractCode, findAlias } = require('../src/extract');

test('extracts readable text from an HTML email without code or styling', () => {
  const html = `<!doctype html><html><head>
    <style>.code { color: red; }</style>
    <script>window.location = 'https://example.com';</script>
  </head><body>
    <h1>Security notice</h1>
    <p>Your verification code is <strong>483921</strong>.</p>
    <a href="https://example.com/track?id=123">Review activity</a>
  </body></html>`;

  const body = extractBodyText('', html);
  assert.match(body, /Security notice/);
  assert.match(body, /Your verification code is 483921\./);
  assert.match(body, /Review activity/);
  assert.doesNotMatch(body, /<html|<style|color:\s*red|window\.location|track\?id=/i);
});

test('cleans HTML source mislabeled as a plain text email', () => {
  const body = extractBodyText(
    '<style>body{font-family:sans-serif}</style><div>Hello</div><p>Code: <b>A7K9P2</b></p>',
    ''
  );
  assert.match(body, /Hello/);
  assert.match(body, /Code: A7K9P2/);
  assert.doesNotMatch(body, /font-family|<div>|<b>/);
});

test('keeps readable plain text and useful line breaks', () => {
  assert.equal(extractBodyText('Hello\r\n\r\nCode: 123456\r\n', ''), 'Hello\n\nCode: 123456');
});

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
