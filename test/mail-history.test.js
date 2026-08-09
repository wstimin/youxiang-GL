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
  assert.match(listRoute, /mode: 'text'/);
  assert.match(listRoute, /parsePublicCursor\(req\.body\.cursor\)/);
  assert.match(listRoute, /Math\.min\(50/);
  assert.match(listRoute, /FROM mail_messages/);
  assert.match(listRoute, /WHERE alias_id = \$1 AND mail_expires_at > NOW\(\)/);
  assert.match(listRoute, /\(received_at, id\) < \(\$4::timestamptz, \$5::bigint\)/);
  assert.match(listRoute, /LIMIT \$6/);
  assert.match(listRoute, /nextCursor:/);
  assert.match(listRoute, /publicMailMessageResponse/);
  assert.match(listRoute, /const codeMode = await verificationModeEnabled\(\)/);
  assert.match(listRoute, /mode: 'code'/);
  assert.match(listRoute, /code_expires_at > NOW\(\)/);
  assert.match(listRoute, /message\.code = decrypt\(row\.code_encrypted\)/);
  assert.match(listRoute, /publicMailboxResponse/);
  assert.match(listRoute, /body_preview ILIKE/);
  assert.match(listRoute, /COUNT\(\*\)::int AS total_count/);
  assert.match(listRoute, /runtime_status/);
  assert.match(listRoute, /heartbeat_at > NOW\(\)/);
  assert.doesNotMatch(listRoute, /body_text_encrypted/);
  assert.doesNotMatch(listRoute, /body_text_encrypted:/);
  assert.match(bodyRoute, /WHERE id = \$1 AND alias_id = \$2 AND mail_expires_at > NOW\(\)/);
  assert.match(bodyRoute, /body_text_encrypted/);
  assert.match(bodyRoute, /message\.body = decrypt\(row\.body_text_encrypted\)/);
  assert.match(bodyRoute, /query_message_blocked/);
  assert.match(bodyRoute, /status\(403\)/);
  assert.doesNotMatch(bodyRoute, /token_encrypted/);
  const batchRoute = server.slice(server.indexOf("app.post('/api/query/batch'"), server.indexOf("app.post('/api/query/batch-inbox'"));
  assert.match(batchRoute, /SELECT id, sender, subject, code_encrypted, received_at, expires_at, mail_expires_at/);
});

test('public mail UI renders plain text bodies and seven-day history', () => {
  assert.match(html, /验证后进入只读收件箱，查看最近 7 天邮件与验证码/);
  assert.match(html, /id="inbox-workspace"/);
  assert.match(html, /id="mail-list-pane"/);
  assert.match(html, /id="mail-detail"/);
  assert.match(script, /cursor: reset \? null : mailState\.cursor/);
  assert.match(script, /limit: 40/);
  assert.match(script, /request\('\/api\/query\/message'/);
  assert.match(script, /querySelector\('\.public-detail-body'\)\.textContent = detail\.body/);
  assert.match(script, /newMailBanner/);
  assert.match(script, /mailboxAddress/);
  assert.match(script, /scheduleMailRefresh/);
  assert.match(script, /data\.mode === 'code'/);
  assert.match(script, /function renderCodeMessage/);
  assert.doesNotMatch(script, /detail\.body[^\n]*innerHTML/);
  assert.match(readme, /邮件默认保存 7 天/);
  assert.match(readme, /不保存附件/);
  assert.match(readme, /不加载远程图片/);
});
