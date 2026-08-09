'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const server = fs.readFileSync('src/server.js', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const schema = fs.readFileSync('src/schema.sql', 'utf8');
const admin = fs.readFileSync('public/admin.js', 'utf8');
const publicQuery = fs.readFileSync('public/query.js', 'utf8');

test('mail account and alias imports enforce a backend limit of 100', () => {
  const accountImport = server.slice(
    server.indexOf("app.post('/api/admin/mail-accounts/import'"),
    server.indexOf("app.get('/api/admin/mail-import-jobs/:id'")
  );
  const aliasImport = server.slice(
    server.indexOf("app.post('/api/admin/aliases/import'"),
    server.indexOf("app.post('/api/admin/aliases/:id/reset'")
  );

  assert.match(accountImport, /requested\.length > 100/);
  assert.match(aliasImport, /requested\.length > 100/);
  assert.match(admin, /accounts\.length > 100/);
  assert.match(admin, /aliases\.length > 100/);
});

test('asynchronous imports are scoped, retryable, and race-safe', () => {
  const jobRoute = server.slice(
    server.indexOf("app.get('/api/admin/mail-import-jobs/:id'"),
    server.indexOf("app.post('/api/admin/mail-import-jobs/:id/retry'")
  );

  assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_import_jobs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_import_items/);
  assert.match(jobRoute, /j\.admin_id = \$2/);
  assert.match(worker, /ON CONFLICT \(email\) DO NOTHING/);
  assert.doesNotMatch(worker, /DELETE FROM mail_accounts WHERE email = \$1/);
  assert.match(worker, /MAIL_WORKER_CONCURRENCY \|\| 5/);
  assert.match(worker, /const retryMinutes = \[1, 5, 15, 30\]/);
});

test('aggregated inbox pages messages and loads plain text details separately', () => {
  const listRoute = server.slice(
    server.indexOf("app.get('/api/admin/messages'"),
    server.indexOf("app.get('/api/admin/messages/:id'")
  );
  const detailRoute = server.slice(
    server.indexOf("app.get('/api/admin/messages/:id'"),
    server.indexOf("app.delete('/api/admin/sessions/:id'")
  );

  assert.match(schema, /UNIQUE \(mail_account_id, uid_validity, uid\)/);
  assert.match(listRoute, /req\.query\.cursor/);
  assert.match(listRoute, /Math\.min\(50/);
  assert.doesNotMatch(listRoute, /body_text_encrypted/);
  assert.match(detailRoute, /body_text_encrypted/);
  assert.match(admin, /escapeHtml\(message\.body/);
  assert.doesNotMatch(publicQuery, /mailAccountId|mail_account_id|provider|母邮箱|子邮箱|归属邮箱/);
});

test('public inbox is a full-screen page app, cursor-paged, and hides commercial account structure', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const styles = fs.readFileSync('public/styles.css', 'utf8');
  const listRoute = server.slice(
    server.indexOf("app.post('/api/query'"),
    server.indexOf("app.post('/api/query/message'")
  );
  const detailRoute = server.slice(
    server.indexOf("app.post('/api/query/message'"),
    server.indexOf("app.post('/api/query/batch'")
  );
  const publicSurface = `${html}\n${publicQuery}\n${listRoute}\n${detailRoute}`;

  assert.match(html, /<body class="public-shell public-app-open">/);
  assert.match(html, /id="inbox-workspace" class="public-app"/);
  assert.match(html, /class="public-app-bar"/);
  assert.match(html, /id="mail-access-panel" class="mail-access-panel"/);
  assert.match(html, /id="mail-access-panel"[\s\S]*?id="mail-query-form"/);
  assert.doesNotMatch(html, /id="access-view"|access-app-bar|access-content|access-mail-preview/);
  assert.match(html, /data-mail-filter="all"[\s\S]*?查看收件箱/);
  assert.match(html, /data-mail-filter="code"[\s\S]*?接收验证码/);
  assert.match(html, /<h1>邮箱<\/h1>/);
  assert.match(styles, /\.public-mail-page \{ width: 100%; height: 100%; display: grid; grid-template-columns: 220px minmax\(350px, \.82fr\) minmax\(460px, 1\.18fr\)/);
  assert.match(styles, /\.public-shell\.public-app-open \{ display: block; height: 100vh;/);
  assert.match(styles, /\.public-app \{ width: 100%; height: 100%;/);
  assert.match(styles, /\.mail-access-panel \{ display: none; \}/);
  assert.match(styles, /\.public-mail-page\.mail-locked \.mail-access-panel/);
  assert.doesNotMatch(styles, /\.access-view|\.access-app-bar|\.access-content|\.access-mail-preview/);
  assert.match(html, /id="mail-list-pane"/);
  assert.match(html, /id="mail-detail"/);
  assert.match(styles, /\.public-mail-page \{ width: 100%; height: 100%; display: grid;/);
  assert.match(styles, /\.public-message-pane \{ min-width: 0; overflow: auto;/);
  assert.match(styles, /\.public-message-detail \{ min-width: 0; overflow: auto;/);
  assert.match(publicQuery, /new IntersectionObserver/);
  assert.match(publicQuery, /cursor: reset \? null : mailState\.cursor/);
  assert.match(publicQuery, /request\('\/api\/query\/message'/);
  assert.match(publicQuery, /mailState\.token/);
  assert.match(publicQuery, /function selectAccessMail\(filter = 'all'\)/);
  assert.match(publicQuery, /mailView\.classList\.add\('mail-locked'\)/);
  assert.doesNotMatch(publicQuery, /accessView|openPublicTool|data-access-view/);
  assert.match(publicQuery, /mailboxHealthDot/);
  assert.doesNotMatch(listRoute, /body_text_encrypted/);
  assert.match(detailRoute, /body_text_encrypted/);
  assert.doesNotMatch(publicSurface, /母邮箱|子邮箱|归属邮箱|邮箱树|服务商|IMAP|mailAccountId|mail_account_id|provider|import job|同步状态|登录失败|网络超时/);
  assert.doesNotMatch(listRoute, /alias:\s*alias|address:\s*alias|label:\s*alias/);
  assert.doesNotMatch(detailRoute, /recipients_encrypted|recipients\s*=/);
  assert.doesNotMatch(listRoute, /decrypt\(message\.code_encrypted\)|code:\s*codeActive/);
  assert.match(detailRoute, /message\.code = message\.hasCode \? decrypt\(row\.code_encrypted\) : null/);
  const batchRoute = server.slice(
    server.indexOf("app.post('/api/query/batch'"),
    server.indexOf("app.post('/api/query/batch-inbox'")
  );
  assert.doesNotMatch(batchRoute, /a\.address|a\.label|alias:\s*maskEmail|label:\s*alias/);
});

test('batch inbox searches seven-day mail and keeps results grouped by masked mailbox', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const styles = fs.readFileSync('public/styles.css', 'utf8');
  const batchInboxRoute = server.slice(
    server.indexOf("app.post('/api/query/batch-inbox'"),
    server.indexOf("app.post('/api/query/totp'")
  );

  assert.match(batchInboxRoute, /req\.body\.tokens\.length > 50/);
  assert.match(batchInboxRoute, /a\.token_digest = ANY\(\$1::text\[\]\)/);
  assert.match(batchInboxRoute, /mail_expires_at > NOW\(\)/);
  assert.match(batchInboxRoute, /sender ILIKE[\s\S]*subject ILIKE[\s\S]*body_preview ILIKE/);
  assert.match(batchInboxRoute, /ROW_NUMBER\(\) OVER \(PARTITION BY alias_id/);
  assert.match(batchInboxRoute, /row_number <= \$3::int \+ 1/);
  assert.match(batchInboxRoute, /verificationModeEnabled\(\)/);
  assert.match(batchInboxRoute, /mailbox = publicMailboxResponse\(alias, stats, runtime\)/);
  assert.match(batchInboxRoute, /mailbox\.matchedMessages = stats\.matched_count/);
  assert.match(batchInboxRoute, /nextCursor:/);
  assert.doesNotMatch(batchInboxRoute, /body_text_encrypted|recipients_encrypted|token_encrypted/);
  assert.match(html, /data-public-view="batch-inbox"/);
  assert.match(html, /id="batch-inbox-search"/);
  assert.match(html, /管理员需关闭“验证码方式”后使用/);
  assert.match(html, /id="batch-inbox-groups"/);
  assert.match(publicQuery, /request\('\/api\/query\/batch-inbox'/);
  assert.match(publicQuery, /data-batch-inbox-toggle/);
  assert.match(publicQuery, /batchInboxState\.expanded/);
  assert.match(publicQuery, /request\('\/api\/query\/message', \{ token, messageId/);
  assert.doesNotMatch(publicQuery, /localStorage|sessionStorage/);
  assert.match(styles, /\.batch-inbox-group\.expanded \.batch-inbox-chevron/);
  assert.match(styles, /\.public-nav \{ min-width: 0; display: flex;[\s\S]*?overflow-x: auto;/);
});
