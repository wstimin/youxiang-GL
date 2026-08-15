'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const server = fs.readFileSync('src/server.js', 'utf8');
const schema = fs.readFileSync('src/schema.sql', 'utf8');
const admin = fs.readFileSync('public/admin.js', 'utf8');
const adminHtml = fs.readFileSync('public/admin.html', 'utf8');
const adminDesign = fs.readFileSync('public/admin-design.css', 'utf8');

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
  assert.match(adminHtml, /data-section="overview"[^>]*>[\s\S]*?class="nav-symbol tone-overview"[^>]*>▦</);
  assert.match(adminHtml, /data-section="mailboxes"[^>]*>[\s\S]*?class="nav-symbol"[^>]*>📥</);
  assert.match(adminHtml, /data-section="aliases"[^>]*>[\s\S]*?class="nav-symbol tone-alias"[^>]*>@</);
  assert.match(adminHtml, /data-section="totp-entries"[^>]*>[\s\S]*?class="nav-symbol"[^>]*>🔐</);
  assert.match(adminHtml, /data-section="messages"[^>]*>[\s\S]*?class="nav-symbol"[^>]*>📋</);
  assert.match(adminHtml, /data-section="security"[^>]*>[\s\S]*?class="nav-symbol"[^>]*>🔑</);
  assert.match(adminHtml, /class="admin-avatar"/);
  assert.match(adminHtml, /class="admin-presence"/);
  assert.match(adminHtml, /id="unmatched-table"/);
  assert.match(adminHtml, /vendor\/lucide\.js\?v=20260809-7/);
  assert.match(adminHtml, /admin\.js\?v=20260816-2/);
  assert.match(adminHtml, /admin-design\.css\?v=20260816-2/);
  assert.doesNotMatch(adminHtml, /styles\.css/);
  assert.match(adminHtml, />管理中心</);
  assert.match(adminHtml, /<title>mail管理<\/title>/);
  assert.match(adminHtml, /mail-favicon\.svg\?v=20260815-1/);
  assert.match(adminHtml, />邮箱管理后台</);
  assert.match(adminHtml, />子邮箱</);
  assert.match(adminHtml, />安全设置</);
  assert.doesNotMatch(adminHtml, /CONTROL CENTER|MAIL ACCOUNTS|SUB MAILBOXES|INBOX RECORDS|SECURITY SETTINGS/);
  assert.doesNotMatch(adminHtml, /API 密钥|API密钥/);
  assert.doesNotMatch(admin, /function modalPresentation/);
  assert.doesNotMatch(adminHtml, /class="nav-totp"|class="twofa-mark"/);
  assert.doesNotMatch(adminHtml, /data-lucide="shield-keyhole"/);
  assert.match(adminDesign, /\.nav button/);
  assert.match(adminDesign, /\.admin-avatar/);
  assert.match(adminDesign, /\.inbox-shell/);
  assert.match(adminDesign, /\.modal-backdrop/);
});

test('admin data-heavy cards paginate without extending the whole page', () => {
  assert.match(admin, /const adminPagination = \{/);
  assert.match(admin, /accounts: \{ resource: 'accounts', page: 1, pageSize: 10/);
  assert.match(admin, /aliases: \{ resource: 'aliases', page: 1, pageSize: 10/);
  assert.match(admin, /totp: \{ resource: 'totp', page: 1, pageSize: 10/);
  assert.match(admin, /securityAudit: \{ resource: 'security-audit', page: 1, pageSize: 10/);
  assert.match(admin, /async function loadAdminList/);
  assert.match(admin, /\/api\/admin\/lists\/\$\{pagination\.resource\}/);
  assert.match(admin, /data-admin-page-size/);
  assert.match(admin, /function bindPaginationActions/);
  assert.doesNotMatch(admin, /rows\.slice\(start, start \+ pagination\.pageSize\)/);
  assert.match(adminHtml, /id="accounts-pagination"/);
  assert.match(adminHtml, /id="aliases-pagination"/);
  assert.match(adminHtml, /id="totp-pagination"/);
  assert.match(adminHtml, /id="unmatched-pagination"/);
  assert.match(adminHtml, /id="overview-audit-pagination"/);
  assert.match(adminHtml, /id="security-audit-pagination"/);
  assert.match(server, /app\.get\('\/api\/admin\/lists\/:resource'/);
  assert.match(server, /SELECT COUNT\(\*\)::int AS total/);
  assert.match(server, /LIMIT \$2 OFFSET \$3/);
  assert.match(server, /pagination: \{ page, pageSize, total, totalPages \}/);
  assert.match(adminDesign, /\.admin-pagination \{/);
  assert.match(adminDesign, /\.pagination-size/);
  assert.match(adminDesign, /\.management-card\.paged-card/);
  assert.match(adminDesign, /\.pagination-page\.active/);
});

test('overview cards and page actions expose existing admin functions', () => {
  assert.match(adminHtml, /id="stats" class="stats"/);
  assert.match(adminHtml, />今日收信</);
  assert.match(adminHtml, />活跃邮箱</);
  assert.match(adminHtml, />验证码提取</);
  assert.match(adminHtml, />2FA 账号</);
  assert.match(adminHtml, /正在加载真实数据/);
  assert.match(admin, /data-overview-action="\$\{action\}"/);
  assert.match(admin, /const metrics = data\.metrics \|\| \{\}/);
  assert.match(admin, /function dailyChange/);
  assert.match(admin, /'今日收信'/);
  assert.match(admin, /'活跃邮箱'/);
  assert.match(admin, /'验证码提取'/);
  assert.match(admin, /'2FA 账号'/);
  assert.match(admin, /'code-messages'/);
  assert.match(admin, /#message-code-only/);
  assert.match(admin, /function runOverviewAction/);
  assert.doesNotMatch(admin, /function runOverviewQuickAction/);
  assert.match(admin, /'#add-account'/);
  assert.match(admin, /'#import-accounts'/);
  assert.match(admin, /'#add-alias'/);
  assert.match(admin, /'#import-aliases'/);
  assert.match(admin, /'#export-new-aliases'/);
  assert.match(admin, /'#export-all-aliases'/);
  assert.doesNotMatch(adminHtml, /id="overview-quick-actions"/);
  assert.match(adminHtml, /id="refresh-inbox"/);
  assert.match(adminHtml, /id="revoke-other-sessions"/);
  assert.match(adminHtml, /id="overview-audit-panel"/);
  assert.match(server, /AS mail_received_today/);
  assert.match(server, /AS mail_received_yesterday/);
  assert.match(server, /AS active_aliases/);
  assert.match(server, /AS aliases_created_last_7_days/);
  assert.match(server, /AS codes_extracted_today/);
  assert.match(server, /AS codes_extracted_yesterday/);
  assert.match(server, /AS totp_accounts/);
  assert.match(server, /AS totp_created_today/);
  assert.match(server, /FROM mail_messages WHERE code_encrypted IS NOT NULL/);
  assert.match(adminDesign, /\.stat-change\.up/);
  assert.match(adminDesign, /\.stat-change\.down/);
  assert.match(adminDesign, /\.stat-change\.neutral/);
});

test('admin mail views show parsed sender names instead of raw addresses', () => {
  assert.match(admin, /function decodeIcloudRelayAddress/);
  assert.match(admin, /function senderDisplayName/);
  assert.match(admin, /senderDisplayName\(row\.sender\)/);
  assert.match(admin, /senderDisplayName\(message\.sender\)/);
  assert.match(server, /app\.get\('\/api\/admin\/search'/);
  assert.match(server, /detail: `\$\{publicSenderName\(row\.sender\)\}/);
});

test('alias secret exports track first downloads without coupling to token changes', () => {
  const exportRoute = server.slice(
    server.indexOf("app.get('/api/admin/aliases/export'"),
    server.indexOf("app.post('/api/admin/aliases/import'")
  );

  const regenerateRoute = server.slice(
    server.indexOf("app.post('/api/admin/aliases/:id/regenerate'"),
    server.indexOf("app.post('/api/admin/aliases/:id/toggle'")
  );

  assert.match(schema, /exported_at TIMESTAMPTZ/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS alias_export_batches/);
  assert.match(schema, /aliases_pending_export_idx/);
  assert.match(schema, /UPDATE aliases SET exported_at = NOW\(\)/);
  assert.match(exportRoute, /SELECT a\.id, a\.address, a\.token_encrypted/);
  assert.match(exportRoute, /a\.exported_at IS NULL/);
  assert.match(exportRoute, /decrypt\(row\.token_encrypted\)/);
  assert.match(exportRoute, /alias_export_batches/);
  assert.match(exportRoute, /UPDATE aliases SET exported_at = NOW\(\)/);
  assert.match(exportRoute, /res\.json\(\{ ok: true, confirmed: updated\.rowCount \}\)/);
  assert.doesNotMatch(exportRoute, /res\.json\([^)]*token_encrypted/);
  assert.doesNotMatch(regenerateRoute, /exported_at/);
  assert.match(admin, /`\$\{row\.address\}--\$\{row\.token\}`/);
  assert.match(admin, /text\/plain;charset=utf-8/);
  assert.match(adminHtml, /id="export-new-aliases"/);
  assert.match(adminHtml, /id="export-all-aliases"/);
  assert.match(admin, /aliases\/export\?mode=\$\{mode\}/);
  assert.match(admin, /aliases\/export\/confirm/);
  assert.match(admin, /aliasIds: data\.created\.map\(\(row\) => row\.id\)/);
  assert.match(server, /created\.push\(\{ id: result\.rows\[0\]\.id, address, token \}\)/);
  assert.match(admin, /downloadText\(`icloud-hq-aliases-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.txt`, formatAliasSecrets\(data\.created\)\)/);
  assert.match(admin, /downloadText\(`icloud-hq-aliases-\$\{suffix\}-\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.txt`, formatAliasSecrets\(data\.aliases\)\)/);
});

test('mail history is always available without a global verification mode switch', () => {
  const stateRoute = server.slice(
    server.indexOf("app.get('/api/admin/state'"),
    server.indexOf("app.post('/api/admin/mail-account/:id/sync'")
  );

  assert.doesNotMatch(schema, /verification_mode_enabled/);
  assert.doesNotMatch(server, /verificationModeEnabled|settings\/verification-mode|query_message_blocked/);
  assert.doesNotMatch(stateRoute, /settings:/);
  assert.doesNotMatch(adminHtml, /verification-mode-enabled|单个查询验证码方式/);
  assert.doesNotMatch(admin, /settings\/verification-mode/);
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
  assert.match(admin, /邮件信息/);
  assert.doesNotMatch(admin, /message\.code|message\.codeMasked|code_masked|验证码识别度|验证码有效期/);
  assert.doesNotMatch(adminHtml, /最近验证码|纯文本邮件|只看验证码</);
});
