'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const server = fs.readFileSync('src/server.js', 'utf8');
const schema = fs.readFileSync('src/schema.sql', 'utf8');
const admin = fs.readFileSync('public/admin.js', 'utf8');
const adminHtml = fs.readFileSync('public/admin.html', 'utf8');
const styles = fs.readFileSync('public/styles.css', 'utf8');

test('mail, alias, and TOTP records have scoped edit routes', () => {
  const mailEdit = server.slice(
    server.indexOf("app.patch('/api/admin/mail-account/:id'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/toggle'")
  );
  const aliasEdit = server.slice(
    server.indexOf("app.patch('/api/admin/aliases/:id'"),
    server.indexOf("app.get('/api/admin/aliases/export'")
  );
  const totpEdit = server.slice(
    server.indexOf("app.patch('/api/admin/totp-entries/:id'"),
    server.indexOf("app.delete('/api/admin/totp-entries/:id'")
  );

  assert.match(mailEdit, /suppliedPassword \|\| decrypt\(current\.rows\[0\]\.app_password_encrypted\)/);
  assert.doesNotMatch(mailEdit, /enabled = TRUE/);
  assert.match(mailEdit, /mail_account_edited/);
  assert.match(aliasEdit, /label = \$3/);
  assert.match(aliasEdit, /WHEN \$4 = 'keep' THEN token_expires_at/);
  assert.doesNotMatch(aliasEdit, /token_digest|token_encrypted|token_hint/);
  assert.match(aliasEdit, /alias_edited/);
  assert.match(totpEdit, /SET issuer = \$1, account_name = \$2/);
  assert.doesNotMatch(totpEdit, /secret_encrypted|secret_fingerprint/);
  assert.match(totpEdit, /totp_entry_edited/);
  assert.match(admin, /openAliasEditor/);
  assert.match(admin, /openTotpEditor/);
  assert.match(admin, /不会修改原始 2FA 密钥/);
  assert.match(admin, /function renderTotpAvatar/);
  assert.match(admin, /class="admin-totp-platform"/);
  assert.match(admin, /page-title'\)\.textContent = button\.title/);
  assert.match(adminHtml, /data-section="totp-entries"[^>]*>[\s\S]*?data-lucide="fingerprint"/);
  assert.match(adminHtml, /class="admin-avatar-person"/);
  assert.match(adminHtml, /class="admin-avatar-face"/);
  assert.match(adminHtml, /class="admin-avatar-hair"/);
  assert.match(adminHtml, /class="admin-avatar-body"/);
  assert.match(adminHtml, /vendor\/lucide\.js\?v=20260809-7/);
  assert.match(adminHtml, /admin\.js\?v=20260809-9/);
  assert.match(adminHtml, /styles\.css\?v=20260809-8/);
  assert.doesNotMatch(adminHtml, /class="nav-totp"|class="twofa-mark"/);
  assert.doesNotMatch(adminHtml, /data-lucide="shield-keyhole"/);
  assert.match(styles, /\.nav button > span/);
  assert.match(styles, /\.admin-avatar-person/);
  assert.doesNotMatch(styles, /\.nav-totp-icon|\.nav button\.nav-totp/);
});

test('alias secret exports use address--token text format', () => {
  const exportRoute = server.slice(
    server.indexOf("app.get('/api/admin/aliases/export'"),
    server.indexOf("app.post('/api/admin/aliases/import'")
  );

  assert.match(exportRoute, /SELECT a\.address, a\.token_encrypted/);
  assert.match(exportRoute, /decrypt\(row\.token_encrypted\)/);
  assert.match(exportRoute, /res\.json\(\{ aliases, skipped \}\)/);
  assert.doesNotMatch(exportRoute, /res\.json\([^)]*token_encrypted/);
  assert.match(admin, /`\$\{row\.address\}--\$\{row\.token\}`/);
  assert.match(admin, /text\/plain;charset=utf-8/);
  assert.match(admin, /icloud-hq-aliases-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.txt/g);
  assert.match(admin, /downloadText\(`icloud-hq-aliases-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.txt`, formatAliasSecrets\(data\.created\)\)/);
  assert.match(admin, /downloadText\(`icloud-hq-aliases-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.txt`, formatAliasSecrets\(data\.aliases\)\)/);
});

test('administrator controls the global single-query verification mode', () => {
  const stateRoute = server.slice(
    server.indexOf("app.get('/api/admin/state'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/sync'")
  );
  const settingsRoute = server.slice(
    server.indexOf("app.post('/api/admin/settings/verification-mode'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/sync'")
  );
  const batchRoute = server.slice(
    server.indexOf("app.post('/api/query/batch'"),
    server.indexOf("app.post('/api/query/totp'")
  );

  assert.match(schema, /verification_mode_enabled/);
  assert.match(stateRoute, /settings: \{ verificationModeEnabled: codeMode \}/);
  assert.match(settingsRoute, /typeof req\.body\.enabled !== 'boolean'/);
  assert.match(settingsRoute, /verification_mode_enabled/);
  assert.match(settingsRoute, /verification_mode_disabled/);
  assert.match(settingsRoute, /await audit\(/);
  assert.match(adminHtml, /id="verification-mode-enabled"[^>]*type="checkbox"[^>]*role="switch"/);
  assert.match(admin, /\/api\/admin\/settings\/verification-mode/);
  assert.match(adminHtml, /批量查询始终固定为验证码方式/);
  assert.doesNotMatch(batchRoute, /verificationModeEnabled|body_text_encrypted|bodyPreview/);
});

test('mail accounts support fixed iCloud, Gmail, and Outlook provider presets', () => {
  const createRoute = server.slice(
    server.indexOf("app.post('/api/admin/mail-account'"),
    server.indexOf("app.patch('/api/admin/mail-account/:id'")
  );
  const editRoute = server.slice(
    server.indexOf("app.patch('/api/admin/mail-account/:id'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/secrets'")
  );

  assert.match(schema, /provider TEXT NOT NULL DEFAULT 'icloud'/);
  assert.match(schema, /LOWER\(host\) = 'imap\.gmail\.com'/);
  assert.match(schema, /'outlook\.office365\.com', 'imap-mail\.outlook\.com'/);
  assert.match(server, /icloud: \{ host: 'imap\.mail\.me\.com', port: 993, secure: true \}/);
  assert.match(server, /gmail: \{ host: 'imap\.gmail\.com', port: 993, secure: true \}/);
  assert.match(server, /outlook: \{ host: 'outlook\.office365\.com', port: 993, secure: true \}/);
  assert.match(createRoute, /const config = mailAccountConfig\(req\.body\)/);
  assert.doesNotMatch(createRoute, /req\.body\.host|req\.body\.port/);
  assert.match(editRoute, /config\.provider !== current\.rows\[0\]\.provider && !suppliedPassword/);
  assert.match(admin, /id="account-provider"/);
  assert.match(admin, /id="edit-account-provider"/);
  assert.match(admin, /Google 应用专用密码/);
  assert.match(admin, /Microsoft 账户或企业租户需要 OAuth/);
  assert.doesNotMatch(admin, /id="account-host"|id="account-port"/);
});

test('mail authorization passwords require administrator confirmation before reveal', () => {
  const revealRoute = server.slice(
    server.indexOf("app.post('/api/admin/mail-account/:id/secrets'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/toggle'")
  );
  const stateRoute = server.slice(
    server.indexOf("app.get('/api/admin/state'"),
    server.indexOf("app.post('/api/admin/sessions/revoke-others'")
  );

  assert.match(revealRoute, /noStore\(res\)/);
  assert.match(revealRoute, /verifyPassword/);
  assert.match(revealRoute, /mail_account_secret_reveal_failed/);
  assert.match(revealRoute, /mail_account_secret_revealed/);
  assert.match(revealRoute, /appPassword: decrypt\(account\.app_password_encrypted\)/);
  assert.doesNotMatch(stateRoute, /app_password_encrypted|appPassword:/);
  assert.match(admin, /data-account-secrets/);
  assert.match(admin, /当前管理员登录密码/);
  assert.match(admin, /copy-app-password/);
});

test('duplicate and invalid relation errors return useful client responses', () => {
  const errorHandler = server.slice(server.indexOf('app.use((error, req, res, _next)'), server.indexOf('async function start()'));
  assert.match(errorHandler, /error\.code === '23505'/);
  assert.match(errorHandler, /status\(409\)/);
  assert.match(errorHandler, /该母邮箱已经存在/);
  assert.match(errorHandler, /该子邮箱已经存在/);
  assert.match(errorHandler, /error\.code === '23503'/);
});

test('sessions and persistent failure guards are backed by database state', () => {
  assert.match(schema, /CREATE SEQUENCE IF NOT EXISTS sessions_session_id_seq/);
  assert.match(schema, /UPDATE sessions SET session_id = nextval/);
  assert.match(schema, /user_agent TEXT NOT NULL DEFAULT ''/);
  assert.match(server, /async function failureGuard/);
  assert.match(server, /FROM audit_logs/);
  assert.match(server, /app\.delete\('\/api\/admin\/sessions\/:id'/);
  assert.match(server, /app\.post\('\/api\/admin\/sessions\/revoke-others'/);
  assert.match(admin, /data-session-revoke/);
});

test('administrator records and mailbox errors use Chinese display labels', () => {
  assert.match(admin, /const auditActionLabels/);
  assert.match(admin, /query_message_success: '邮件正文查询成功'/);
  assert.match(admin, /aliases_imported: '已批量导入邮箱'/);
  assert.match(admin, /function auditActorLabel/);
  assert.match(admin, /公开查询端/);
  assert.match(admin, /管理员二次验证/);
  assert.match(admin, /function auditDetailLabel/);
  assert.match(admin, /查询密钥格式无效/);
  assert.match(admin, /请求 \$\{requestedMatch\[1\]\} 条，无效 \$\{requestedMatch\[2\]\} 条/);
  assert.match(admin, /function auditRecordDetail/);
  assert.match(admin, /共退出 \$\{String\(row\.detail\)\.trim\(\)\} 个会话/);
  assert.match(admin, /function mailErrorLabel/);
  assert.match(admin, /连接邮箱服务器超时，请检查服务器出站网络和 TCP 993 端口/);
  assert.match(admin, /邮箱登录失败，请检查邮箱地址和应用专用密码/);
  assert.match(admin, /验证码识别度/);
  assert.match(admin, /验证码有效期/);
});
