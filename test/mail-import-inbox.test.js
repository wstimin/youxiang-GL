'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const server = fs.readFileSync('src/server.js', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');
const schema = fs.readFileSync('src/schema.sql', 'utf8');
const admin = fs.readFileSync('public/admin.js', 'utf8');
const publicQuery = fs.readFileSync('public/query.js', 'utf8');

test('backend mail account imports allow 10 while alias imports allow 100', () => {
  const accountImport = server.slice(
    server.indexOf("app.post('/api/admin/mail-accounts/import'"),
    server.indexOf("app.get('/api/admin/mail-import-jobs/:id'")
  );
  const aliasImport = server.slice(
    server.indexOf("app.post('/api/admin/aliases/import'"),
    server.indexOf("app.post('/api/admin/aliases/:id/reset'")
  );

  assert.match(accountImport, /requested\.length > 10/);
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

  assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_folders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mail_message_locations/);
  assert.match(schema, /UNIQUE \(mail_folder_id, uid_validity, uid\)/);
  assert.doesNotMatch(schema, /UNIQUE \(mail_message_id, mail_folder_id\)/);
  assert.match(worker, /client\.list\(\)/);
  assert.match(worker, /!hasMailboxFlag\(folder, '\\\\Noselect'\)/);
  assert.match(worker, /history_synced_at/);
  assert.match(worker, /ON CONFLICT \(mail_account_id, message_id\) WHERE message_id <> ''/);
  assert.match(worker, /mail_message_locations/);
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
  assert.match(html, /<section id="mail-view" class="public-page public-mail-page"/);
  assert.match(html, /<header class="public-tool-head">[\s\S]*?<h1>邮箱<\/h1>/);
  assert.match(html, /<form id="mail-query-form" class="public-tool-form mail-query-form">/);
  assert.match(html, /data-mail-filter="all"[\s\S]*?查看收件箱/);
  assert.match(html, /data-mail-filter="code"[\s\S]*?接收验证码/);
  assert.doesNotMatch(html, /mail-function-pane|mail-access-panel|id="access-view"|access-app-bar|access-content|access-mail-preview/);
  assert.match(styles, /\.public-mail-layout \{ grid-template-columns: minmax\(330px, \.72fr\) minmax\(440px, 1\.28fr\)/);
  assert.match(styles, /\.mail-action-buttons \{ display: grid; gap: 9px; \}/);
  assert.match(styles, /\.public-shell\.public-app-open \{ display: block; height: 100vh;/);
  assert.match(styles, /\.public-app \{ width: 100%; height: 100%;/);
  assert.match(html, /id="mail-placeholder" class="public-tool-placeholder"/);
  assert.match(html, /class="mail-results-pane"/);
  assert.match(html, /id="mail-list-pane"/);
  assert.match(html, /id="mail-detail"/);
  assert.match(styles, /\.public-mail-page \{ width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;/);
  assert.match(styles, /\.public-message-pane \{ min-width: 0; overflow: auto;/);
  assert.match(styles, /\.public-message-detail \{ min-width: 0; overflow: auto;/);
  assert.match(publicQuery, /new IntersectionObserver/);
  assert.match(publicQuery, /cursor: reset \? null : mailState\.cursor/);
  assert.match(publicQuery, /request\('\/api\/query\/message'/);
  assert.match(publicQuery, /mailState\.token/);
  assert.match(publicQuery, /function selectAccessMail\(filter = 'all'\)/);
  assert.match(publicQuery, /setMailResultsVisible\(false\)/);
  assert.match(publicQuery, /event\.submitter \|\| mailForm\.querySelector/);
  assert.doesNotMatch(publicQuery, /accessView|openPublicTool|data-access-view/);
  assert.match(publicQuery, /mailboxHealthDot/);
  assert.doesNotMatch(listRoute, /body_text_encrypted/);
  assert.match(detailRoute, /body_text_encrypted/);
  assert.doesNotMatch(publicSurface, /母邮箱|子邮箱|归属邮箱|邮箱树|服务商|IMAP|mailAccountId|mail_account_id|provider|import job|同步状态|登录失败|网络超时/);
  assert.doesNotMatch(listRoute, /alias:\s*alias|address:\s*alias|label:\s*alias/);
  assert.doesNotMatch(detailRoute, /recipients_encrypted|message\.recipients/);
  assert.doesNotMatch(listRoute, /decrypt\(message\.code_encrypted\)|code:\s*codeActive/);
  assert.doesNotMatch(detailRoute, /message\.code|decrypt\(row\.code_encrypted\)|codeMasked|confidence/);
  assert.match(detailRoute, /message\.body = extractBodyText\(decrypt\(row\.body_text_encrypted\), ''\)/);
  const batchRoute = server.slice(
    server.indexOf("app.post('/api/query/batch'"),
    server.indexOf("app.post('/api/query/batch-inbox'")
  );
  assert.doesNotMatch(batchRoute, /a\.address|a\.label|alias:\s*maskEmail|label:\s*alias/);
});

test('batch inbox searches seven-day mail in a three-pane workspace by full mailbox address', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const styles = fs.readFileSync('public/styles.css', 'utf8');
  const batchInboxRoute = server.slice(
    server.indexOf("app.post('/api/query/batch-inbox'"),
    server.indexOf("app.post('/api/query/totp'")
  );

  assert.match(batchInboxRoute, /req\.body\.tokens\.length > 50/);
  assert.match(batchInboxRoute, /req\.body\.tokens\.map\(normalizePublicToken\)/);
  assert.match(batchInboxRoute, /status: 'invalid_format'/);
  assert.doesNotMatch(batchInboxRoute, /rateLimit\(|failureGuard\(/);
  assert.match(batchInboxRoute, /a\.token_digest = ANY\(\$1::text\[\]\)/);
  assert.match(batchInboxRoute, /mail_expires_at > NOW\(\)/);
  assert.match(batchInboxRoute, /sender ILIKE[\s\S]*subject ILIKE[\s\S]*body_preview ILIKE/);
  assert.match(batchInboxRoute, /ROW_NUMBER\(\) OVER \(PARTITION BY alias_id/);
  assert.match(batchInboxRoute, /row_number <= \$3::int \+ 1/);
  assert.doesNotMatch(batchInboxRoute, /verificationModeEnabled\(\)|status\(403\)/);
  assert.match(batchInboxRoute, /mailbox = publicMailboxResponse\(alias, stats, runtime\)/);
  assert.match(batchInboxRoute, /mailbox\.matchedMessages = stats\.matched_count/);
  assert.match(batchInboxRoute, /nextCursor:/);
  assert.match(server, /address: alias\.address/);
  assert.doesNotMatch(server, /maskEmail\(alias\.address\)/);
  assert.doesNotMatch(batchInboxRoute, /body_text_encrypted|recipients_encrypted|token_encrypted/);
  assert.match(html, /data-public-view="batch-inbox"/);
  assert.match(html, /id="batch-inbox-search"/);
  assert.doesNotMatch(html, /验证码方式/);
  assert.match(html, /id="batch-inbox-workspace"/);
  assert.match(html, /id="batch-inbox-mailboxes"/);
  assert.match(html, /id="batch-inbox-messages"/);
  assert.match(html, /id="batch-inbox-message-detail"/);
  assert.match(html, /id="batch-inbox-import-dialog"/);
  assert.doesNotMatch(html, /id="expand-batch-inbox"|id="collapse-batch-inbox"|id="batch-inbox-groups"/);
  assert.match(publicQuery, /request\('\/api\/query\/batch-inbox'/);
  assert.match(publicQuery, /function splitQueryTokens\(tokens, size = 50\)/);
  assert.match(publicQuery, /requestBatchTokens\('\/api\/query\/batch-inbox'/);
  assert.doesNotMatch(publicQuery, /tokens\.length > 50/);
  assert.match(publicQuery, /data-batch-inbox-mailbox/);
  assert.match(publicQuery, /batchInboxState\.selectedMailboxIndex/);
  assert.doesNotMatch(publicQuery, /batchInboxState\.expanded|data-batch-inbox-toggle/);
  assert.match(publicQuery, /request\('\/api\/query\/message', \{ token, messageId/);
  assert.match(publicQuery, /batchInboxMessageDetail\.innerHTML/);
  assert.doesNotMatch(publicQuery, /batchInboxDetail\.showModal/);
  assert.match(publicQuery, /batchInboxImportDialog\.showModal/);
  assert.match(publicQuery, /loadBatchInbox\(\{ preserveSelection: true, errorBox: batchInboxReimportError \}\)/);
  assert.match(publicQuery, /batch-inbox-message-subject/);
  assert.match(publicQuery, /batch-inbox-message-preview/);
  assert.match(publicQuery, /batch-inbox-message-line[\s\S]*?formatMailDate\(message\.receivedAt\)/);
  assert.doesNotMatch(publicQuery, /formatFolders\(message\.folders\)|formatFolders\(detail\.folders\)|所在文件夹/);
  assert.doesNotMatch(publicQuery, /public-code-badge|detail\.code|message\.hasCode|data-copy-detail-code|纯文本正文/);
  assert.doesNotMatch(publicQuery, /localStorage|sessionStorage/);
  assert.match(styles, /\.batch-inbox-workspace \{[^}]*grid-template-columns: minmax\(230px, \.65fr\) minmax\(320px, \.9fr\) minmax\(420px, 1\.45fr\)/);
  assert.match(styles, /\.batch-inbox-workspace\.show-detail \.batch-inbox-message-detail/);
  assert.match(styles, /\.public-nav \{ min-width: 0; display: flex;[\s\S]*?overflow-x: auto;/);
});
