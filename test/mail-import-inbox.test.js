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

test('public inbox is three-column, cursor-paged, and hides commercial account structure', () => {
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

  assert.match(html, /class="public-inbox-workspace/);
  assert.match(html, /class="public-inbox-nav"/);
  assert.match(html, /id="mail-list-pane"/);
  assert.match(html, /id="mail-detail"/);
  assert.match(styles, /grid-template-columns: 210px minmax\(350px, 430px\) minmax\(460px, 1fr\)/);
  assert.match(publicQuery, /new IntersectionObserver/);
  assert.match(publicQuery, /cursor: reset \? null : mailState\.cursor/);
  assert.match(publicQuery, /request\('\/api\/query\/message'/);
  assert.match(publicQuery, /mailState\.token/);
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
    server.indexOf("app.post('/api/query/totp'")
  );
  assert.doesNotMatch(batchRoute, /a\.address|a\.label|alias:\s*maskEmail|label:\s*alias/);
});
