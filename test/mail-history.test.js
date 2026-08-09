'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const schema = fs.readFileSync('src/schema.sql', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const lib = fs.readFileSync('src/lib.js', 'utf8');
const server = fs.readFileSync('src/server.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const script = fs.readFileSync('public/query.js', 'utf8');
const env = fs.readFileSync('.env.example', 'utf8');
const deploy = fs.readFileSync('deploy.sh', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

test('matched mail stores encrypted plain text for seven days without attachments', () => {
  assert.match(schema, /body_text_encrypted TEXT/);
  assert.match(schema, /mail_expires_at TIMESTAMPTZ/);
  assert.match(schema, /INTERVAL '7 days'/);
  assert.match(schema, /verification_messages_mail_expires_idx/);
  assert.match(schema, /body_sync_completed_at TIMESTAMPTZ/);
  assert.match(worker, /MAIL_RETENTION_DAYS \|\| 7/);
  assert.match(worker, /MAX_BODY_CHARS \|\| 200000/);
  assert.match(worker, /skipHtmlToText: false/);
  assert.match(worker, /bodyText \? encrypt\(bodyText\) : null/);
  assert.match(worker, /client\.search\(\{ since \}, \{ uid: true \}\)/);
  assert.match(worker, /body_sync_completed_at = COALESCE\(body_sync_completed_at, NOW\(\)\)/);
  assert.doesNotMatch(worker, /parsed\.attachments|attachments:/);
  assert.match(env, /MAIL_RETENTION_DAYS=7/);
  assert.match(deploy, /MAIL_RETENTION_DAYS=7/);
});

test('cleanup separates code expiry from mail retention', () => {
  assert.match(lib, /SET code_encrypted = NULL, code_masked = NULL/);
  assert.match(lib, /WHERE expires_at < NOW\(\)/);
  assert.match(lib, /DELETE FROM verification_messages[\s\S]*mail_expires_at < NOW\(\)/);
  assert.doesNotMatch(lib, /DELETE FROM verification_messages WHERE expires_at < NOW\(\)/);
});

test('single-token query lists scoped mail and protects full body lookup', () => {
  const listRoute = server.slice(server.indexOf("app.post('/api/query'"), server.indexOf("app.post('/api/query/message'"));
  const bodyRoute = server.slice(server.indexOf("app.post('/api/query/message'"), server.indexOf("app.post('/api/query/batch'"));
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(schema, /VALUES \('verification_mode_enabled', 'true'\)/);
  assert.match(listRoute, /verificationModeEnabled\(\)/);
  assert.match(listRoute, /mode: 'code'/);
  assert.match(listRoute, /expires_at > NOW\(\) AND code_encrypted IS NOT NULL/);
  const codeModeRoute = listRoute.slice(listRoute.indexOf('if (await verificationModeEnabled())'), listRoute.indexOf('const page ='));
  assert.match(codeModeRoute, /code: decrypt\(row\.code_encrypted\)/);
  assert.doesNotMatch(codeModeRoute, /mailMessageResponse|body:|bodyPreview/);
  assert.match(listRoute, /mode: 'text'/);
  assert.match(listRoute, /WHERE alias_id = \$1 AND mail_expires_at > NOW\(\)/);
  assert.match(listRoute, /LIMIT \$2 OFFSET \$3/);
  assert.match(listRoute, /pagination: \{ page, pageSize, total, hasMore/);
  assert.match(listRoute, /bodyPreview:/);
  assert.doesNotMatch(listRoute, /body_text_encrypted:/);
  assert.match(bodyRoute, /WHERE id = \$1 AND alias_id = \$2 AND mail_expires_at > NOW\(\)/);
  assert.match(bodyRoute, /verificationModeEnabled\(\)/);
  assert.match(bodyRoute, /status\(403\)/);
  assert.match(bodyRoute, /mailMessageResponse\(result\.rows\[0\], true\)/);
  assert.doesNotMatch(bodyRoute, /token_encrypted/);
  const batchRoute = server.slice(server.indexOf("app.post('/api/query/batch'"), server.indexOf("app.post('/api/query/totp'"));
  assert.match(batchRoute, /SELECT id, sender, subject, code_encrypted, received_at, expires_at, mail_expires_at/);
});

test('public mail UI renders plain text bodies and seven-day history', () => {
  assert.match(html, /验证码或 7 天邮件/);
  assert.match(html, /请在下方输入邮件查询密钥。/);
  assert.match(script, /data\.mode === 'code'/);
  assert.match(script, /function renderMailCode/);
  assert.match(script, /function renderMailText/);
  assert.match(script, /request\('\/api\/query\/message'/);
  assert.match(script, /body\.textContent = data\.message\.body/);
  assert.match(script, /className = 'mail-body'/);
  assert.doesNotMatch(script, /data\.message\.body[^\n]*innerHTML/);
  assert.match(readme, /邮件默认保存 7 天/);
  assert.match(readme, /不保存附件/);
  assert.match(readme, /不加载远程图片/);
});
