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
  assert.match(worker, /skipHtmlToText: true/);
  assert.match(worker, /extractBodyText\(parsed\.text, parsed\.html\)/);
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
  assert.match(listRoute, /parsePublicCursor\(req\.body\.cursor\)/);
  assert.match(listRoute, /normalizePublicToken\(req\.body\.token\)/);
  assert.doesNotMatch(listRoute, /rateLimit\(|failureGuard\(/);
  assert.match(listRoute, /Math\.min\(50/);
  assert.match(listRoute, /FROM mail_messages/);
  assert.match(listRoute, /WHERE alias_id = \$1 AND mail_expires_at > NOW\(\)/);
  assert.match(listRoute, /\(received_at, id\) < \(\$4::timestamptz, \$5::bigint\)/);
  assert.match(listRoute, /LIMIT \$6/);
  assert.match(listRoute, /nextCursor:/);
  assert.match(listRoute, /publicMailMessageResponse/);
  assert.match(listRoute, /code_expires_at > NOW\(\)/);
  assert.match(listRoute, /publicCodeMessageResponse/);
  assert.match(server, /function publicCodeMessageResponse\(message\)[\s\S]*?decrypt\(message\.code_encrypted\)/);
  assert.match(listRoute, /codeOnly \? publicCodeMessageResponse : publicMailMessageResponse/);
  assert.match(listRoute, /publicMailboxResponse/);
  assert.match(listRoute, /body_preview ILIKE/);
  assert.match(listRoute, /COUNT\(\*\)::int AS total_count/);
  assert.match(listRoute, /runtime_status/);
  assert.match(listRoute, /heartbeat_at > NOW\(\)/);
  assert.doesNotMatch(listRoute, /body_text_encrypted/);
  assert.doesNotMatch(listRoute, /body_text_encrypted:/);
  assert.match(bodyRoute, /WHERE id = \$1 AND alias_id = \$2 AND mail_expires_at > NOW\(\)/);
  assert.match(bodyRoute, /body_text_encrypted/);
  assert.match(bodyRoute, /message\.body = extractBodyText\(decrypt\(row\.body_text_encrypted\), ''\)/);
  assert.doesNotMatch(bodyRoute, /query_message_blocked|status\(403\)|verificationModeEnabled/);
  assert.doesNotMatch(bodyRoute, /rateLimit\(|failureGuard\(/);
  assert.doesNotMatch(bodyRoute, /token_encrypted/);
  const batchRoute = server.slice(server.indexOf("app.post('/api/query/batch'"), server.indexOf("app.post('/api/query/batch-inbox'"));
  assert.match(batchRoute, /SELECT id, sender, subject, mailbox_paths, code_encrypted, received_at, expires_at, mail_expires_at/);
});

test('public mail UI renders plain text bodies and seven-day history', () => {
  assert.match(html, /输入查询密钥后，查看发件人、主题、时间和邮件内容/);
  assert.match(html, /接收验证码/);
  assert.doesNotMatch(html, /mail-code-count/);
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
  assert.doesNotMatch(script, /data\.mode === 'code'|mailState\.mode|function renderCodeMessage/);
  assert.match(script, /function renderCodeItem\(message\)/);
  assert.match(script, /data-copy-mail-code/);
  assert.match(script, /mailState\.filter === 'code' \? renderCodeItem : renderMessageItem/);
  assert.doesNotMatch(script, /detail\.body[^\n]*innerHTML/);
  assert.match(script, /邮件内容/);
  assert.doesNotMatch(script, /formatFolders\(message\.folders\)|formatFolders\(detail\.folders\)|所在文件夹/);
  const detailRenderer = script.slice(
    script.indexOf('async function openMailMessage'),
    script.indexOf('function parseBatchTokens')
  );
  assert.doesNotMatch(detailRenderer, /纯文本正文|已提取验证码|data-copy-detail-code|detail\.code|message\.code|message\.hasCode/);
  assert.match(readme, /邮件默认保存 7 天/);
  assert.match(readme, /不保存附件/);
  assert.match(readme, /不加载远程图片/);
});
