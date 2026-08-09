'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSecret, parseTotpInput, generateTotp } = require('../src/totp');

test('normalizes a Base32 TOTP secret', () => {
  assert.equal(normalizeSecret('jbsw y3dp-ehpk3pxp==='), 'JBSWY3DPEHPK3PXP');
});

test('parses a standard otpauth TOTP URI', () => {
  assert.deepEqual(
    parseTotpInput('otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'),
    { secret: 'JBSWY3DPEHPK3PXP', issuer: 'GitHub', accountName: 'user@example.com' }
  );
});

test('rejects HOTP and unsupported TOTP parameters', () => {
  assert.throws(() => parseTotpInput('otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=1'), /不支持 HOTP/);
  assert.throws(() => parseTotpInput('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=8'), /仅支持 SHA1/);
  assert.throws(() => parseTotpInput('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=60'), /仅支持 SHA1/);
  assert.throws(() => parseTotpInput('A'.repeat(4097)), /过长/);
});

test('generates the RFC 6238 compatible six digit token and timing metadata', () => {
  assert.deepEqual(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), {
    code: '287082',
    period: 30,
    remaining: 1,
    generatedAt: '1970-01-01T00:00:59.000Z'
  });
});

test('public and routine admin responses never expose a stored TOTP secret', () => {
  const server = require('node:fs').readFileSync('src/server.js', 'utf8');
  const publicTotpRoute = server.slice(server.indexOf("app.post('/api/query/totp'"), server.indexOf("app.post('/api/admin/login'"));
  const stateRoute = server.slice(server.indexOf("app.get('/api/admin/state'"), server.indexOf("app.post('/api/admin/mail-account'"));
  assert.match(server, /res\.json\(\{ totps: converted \}\)/);
  assert.doesNotMatch(publicTotpRoute, /secret_encrypted|decrypt\(|secret:\s*(?:saved|parsed|entry)/);
  assert.match(stateRoute, /token_encrypted IS NOT NULL\) AS token_recoverable/);
  assert.match(stateRoute, /SELECT id, secret_hint, issuer, account_name, legacy_alias_address/);
  assert.doesNotMatch(stateRoute, /a\.token_encrypted\s*,|SELECT id, secret_encrypted|decrypt\(|totpEntries:[^\n]*secret/);
});

test('administrator secret reveal requires password confirmation and is audited', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync('src/server.js', 'utf8');
  const schema = fs.readFileSync('src/schema.sql', 'utf8');
  const admin = fs.readFileSync('public/admin.js', 'utf8');
  const aliasRoute = server.slice(server.indexOf("app.post('/api/admin/aliases/:id/secrets'"), server.indexOf("app.post('/api/admin/totp-entries/:id/secrets'"));
  const totpRoute = server.slice(server.indexOf("app.post('/api/admin/totp-entries/:id/secrets'"), server.indexOf("app.delete('/api/admin/totp-entries/:id'"));
  assert.match(schema, /token_encrypted TEXT/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS totp_entries/);
  assert.match(server, /INSERT INTO aliases\(mail_account_id, address, label, token_digest, token_encrypted/);
  assert.match(server, /\[accountId, address, label, digest\(token\), encrypt\(token\)/);
  assert.match(server, /token_digest = \$1, token_encrypted = \$2/);
  assert.match(aliasRoute, /verifyPassword\(password/);
  assert.match(aliasRoute, /alias_secrets_revealed/);
  assert.match(aliasRoute, /queryToken: decrypt\(alias\.token_encrypted\)/);
  assert.match(totpRoute, /verifyPassword/);
  assert.match(totpRoute, /totp_secret_revealed/);
  assert.match(totpRoute, /secret = decrypt\(entry\.secret_encrypted\)/);
  assert.match(admin, /data-alias-secrets/);
  assert.match(admin, /data-totp-secrets/);
  assert.match(admin, /当前管理员密码/);
});

test('standalone TOTP storage is independent from mail aliases', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync('src/server.js', 'utf8');
  const schema = fs.readFileSync('src/schema.sql', 'utf8');
  const mailRoute = server.slice(server.indexOf("app.post('/api/query'"), server.indexOf("app.post('/api/query/totp'"));
  const totpRoute = server.slice(server.indexOf("app.post('/api/query/totp'"), server.indexOf("app.post('/api/admin/login'"));
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS totp_entries'), schema.indexOf('CREATE TABLE IF NOT EXISTS verification_messages'));
  assert.doesNotMatch(table, /alias_id|REFERENCES aliases/);
  assert.doesNotMatch(mailRoute, /saveStandaloneTotp|totp_entries/);
  assert.doesNotMatch(totpRoute, /verification_messages|code_encrypted/);
  assert.doesNotMatch(totpRoute, /findPublicAlias|req\.body\.token/);
  assert.match(totpRoute, /req\.body\.entries/);
  assert.match(totpRoute, /req\.body\.secret/);
  assert.match(server, /ON CONFLICT \(secret_fingerprint\) DO UPDATE/);
});

test('public page keeps mail and TOTP in separate tabs and forms', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const script = fs.readFileSync('public/query.js', 'utf8');
  assert.match(html, /data-public-view="mail"/);
  assert.match(html, /data-public-view="totp"/);
  assert.match(html, /id="mail-query-form"/);
  assert.match(html, /id="totp-query-form"/);
  assert.match(html, /id="totp-secret"/);
  assert.match(html, />获取 2FA 验证码</);
  assert.doesNotMatch(html, /转换并保存 2FA/);
  assert.doesNotMatch(script, /已转换并同步到管理后台/);
  assert.match(html, /id="totp-view"/);
  assert.match(html, /styles\.css\?v=20260809-13/);
  assert.match(html, /vendor\/lucide\.js\?v=20260809-7/);
  assert.match(html, /query\.js\?v=20260809-13/);
  assert.match(html, /data-public-view="totp"[\s\S]*?2FA 工具/);
  assert.doesNotMatch(html, /class="twofa-mark"/);
  assert.doesNotMatch(html, /data-lucide="shield-keyhole"/);
  assert.doesNotMatch(html, /id="totp-token"/);
  assert.match(script, /request\('\/api\/query', \{/);
  assert.match(script, /limit: 40/);
  assert.match(script, /request\('\/api\/query\/totp', \{ entries \}\)/);
  assert.match(script, /const activeTotps = new Map\(\)/);
  assert.match(script, /function renderTotpAvatar/);
  assert.match(script, /class="totp-entry"/);
});

test('public mail lookup supports bounded batches and automatic refresh', () => {
  const fs = require('node:fs');
  const server = fs.readFileSync('src/server.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const script = fs.readFileSync('public/query.js', 'utf8');
  const batchRoute = server.slice(server.indexOf("app.post('/api/query/batch'"), server.indexOf("app.post('/api/query/totp'"));

  assert.match(server, /BATCH_QUERY_LIMIT_PER_10_MINUTES \|\| 50/);
  assert.match(batchRoute, /req\.body\.tokens\.length > 50/);
  assert.match(batchRoute, /a\.token_digest = ANY\(\$1::text\[\]\)/);
  assert.match(batchRoute, /LEFT JOIN LATERAL/);
  assert.match(batchRoute, /status: message \? 'received' : 'waiting'/);
  assert.match(batchRoute, /status: 'invalid'/);
  assert.match(batchRoute, /refreshAfterSeconds: 15/);
  assert.doesNotMatch(batchRoute, /token_encrypted|SELECT[^\n]*address[^\n]*token_encrypted/);
  assert.match(html, /data-public-view="mail"/);
  assert.match(html, /data-public-view="batch"/);
  assert.match(html, /id="mail-batch-tokens"/);
  assert.match(html, /id="mail-batch-result"/);
  assert.match(script, /request\('\/api\/query\/batch', \{ tokens \}\)/);
  assert.match(script, /setTimeout\(\(\) => refreshMailBatch\(\)/);
  assert.match(script, /let activeMailBatchTokens = \[\]/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test('public QR recognition stays local and only fills the raw TOTP input', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const script = fs.readFileSync('public/query.js', 'utf8');

  assert.match(html, /id="totp-qr-file"/);
  assert.match(script, /new BarcodeDetector\(\{ formats: \['qr_code'\] \}\)/);
  assert.match(script, /startsWith\('otpauth:\/\/totp\/'\)/);
  assert.match(script, /totpSecretInput\.value = await detectQrCode\(file\)/);
  assert.doesNotMatch(script, /FormData|\/api\/.*qr|fetch\([^\n]*file/);
});
