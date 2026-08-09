'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { ImapFlow } = require('imapflow');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const { parseTotpInput, generateTotp } = require('./totp');
const {
  pool, initDatabase, randomToken, digest, encrypt, decrypt, hashPassword,
  verifyPassword, normalizeEmail, validEmail, maskEmail, extractClientIp,
  audit, cleanExpired
} = require('./lib');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionHours = Number(process.env.SESSION_HOURS || 12);
const queryLimit = Number(process.env.QUERY_LIMIT_PER_10_MINUTES || 30);
const batchQueryLimit = Number(process.env.BATCH_QUERY_LIMIT_PER_10_MINUTES || 50);
const loginLimit = Number(process.env.LOGIN_LIMIT_PER_15_MINUTES || 10);
const queryFailureLimit = Number(process.env.QUERY_FAILURE_LIMIT_PER_15_MINUTES || 8);
const mailPageSize = Math.max(1, Math.min(50, Number(process.env.MAIL_PAGE_SIZE || 20)));
const loginFailureLimit = Number(process.env.LOGIN_FAILURE_LIMIT_PER_15_MINUTES || 5);
const workerFreshSeconds = Math.max(90, Number(process.env.IMAP_POLL_SECONDS || 15) * 4);
const adminAllowedIps = new Set(String(process.env.ADMIN_ALLOWED_IPS || '')
  .split(',').map((item) => item.trim()).filter(Boolean));
const rateBuckets = new Map();
const mailProviders = Object.freeze({
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true },
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true }
});

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/assets', express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1h',
  index: false
}));

function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

function mailAccountConfig(body, current = null) {
  const provider = String(body.provider || current?.provider || 'icloud').trim().toLowerCase();
  if (!mailProviders[provider]) throw new Error('UNSUPPORTED_MAIL_PROVIDER');
  return { provider, ...mailProviders[provider] };
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return '';
}

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  return {
    allowed: current.count <= max,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

async function failureGuard(action, ip, max, windowMinutes = 15) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (
        MIN(created_at) + ($3::text || ' minutes')::interval - NOW()
      )))::int) AS retry_after
     FROM audit_logs
     WHERE action = $1 AND ip_digest = $2
       AND created_at > NOW() - ($3::text || ' minutes')::interval`,
    [action, digest(ip), String(windowMinutes)]
  );
  const row = result.rows[0];
  return { allowed: row.count < max, retryAfter: row.retry_after || windowMinutes * 60 };
}

async function findPublicAlias(token) {
  if (token.length < 20 || token.length > 200) return null;
  const result = await pool.query(
    `SELECT id, address, label FROM aliases
     WHERE token_digest = $1 AND enabled = TRUE
       AND (token_expires_at IS NULL OR token_expires_at > NOW())`,
    [digest(token)]
  );
  return result.rows[0] || null;
}

function mailMessageResponse(message, includeBody = false) {
  const codeActive = message.code_encrypted && new Date(message.expires_at).getTime() > Date.now();
  return {
    id: message.id,
    sender: message.sender,
    subject: message.subject,
    body: includeBody ? decrypt(message.body_text_encrypted) : null,
    bodyPreview: message.body_preview || '',
    code: codeActive ? decrypt(message.code_encrypted) : null,
    codeMasked: codeActive ? message.code_masked : null,
    confidence: message.confidence,
    receivedAt: message.received_at,
    expiresAt: message.expires_at,
    mailExpiresAt: message.mail_expires_at
  };
}

function totpEntryResponse(entry, secret) {
  return {
    id: entry.id,
    ...generateTotp(secret),
    issuer: entry.issuer || '',
    accountName: entry.account_name || '',
    secretHint: secret.slice(-4)
  };
}

async function saveStandaloneTotp(input, issuerInput = '', accountNameInput = '') {
  const parsed = parseTotpInput(input);
  generateTotp(parsed.secret);
  const issuer = parsed.issuer || String(issuerInput || '').trim().slice(0, 120);
  const accountName = parsed.accountName || String(accountNameInput || '').trim().slice(0, 160);
  const result = await pool.query(
    `INSERT INTO totp_entries(
       secret_encrypted, secret_fingerprint, secret_hint, issuer, account_name, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (secret_fingerprint) DO UPDATE SET
       issuer = CASE WHEN EXCLUDED.issuer = '' THEN totp_entries.issuer ELSE EXCLUDED.issuer END,
       account_name = CASE WHEN EXCLUDED.account_name = '' THEN totp_entries.account_name ELSE EXCLUDED.account_name END,
       last_used_at = NOW(), updated_at = NOW()
     RETURNING id, issuer, account_name`,
    [encrypt(parsed.secret), digest(`totp:${parsed.secret}`), parsed.secret.slice(-4), issuer, accountName]
  );
  return { entry: result.rows[0], secret: parsed.secret };
}

function adminNetwork(req, res, next) {
  if (!adminAllowedIps.size || adminAllowedIps.has(extractClientIp(req))) return next();
  return res.status(403).json({ error: '此网络无权访问管理端' });
}

async function sessionAuth(req, res, next) {
  try {
    const sessionToken = readCookie(req, 'cv_session');
    if (!sessionToken) return res.status(401).json({ error: '请先登录' });
    const result = await pool.query(
      `SELECT s.csrf_token, s.expires_at, u.id, u.email, u.role, u.totp_secret_encrypted
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = $1 AND s.expires_at > NOW()`,
      [digest(sessionToken)]
    );
    if (!result.rowCount) return res.status(401).json({ error: '登录已失效' });
    req.admin = result.rows[0];
    req.sessionToken = sessionToken;
    next();
  } catch (error) {
    next(error);
  }
}

async function adminPageAuth(req, res, next) {
  const sessionToken = readCookie(req, 'cv_session');
  if (!sessionToken) return res.redirect('/admin/login');
  try {
    const result = await pool.query(
      'SELECT 1 FROM sessions WHERE id_hash = $1 AND expires_at > NOW()',
      [digest(sessionToken)]
    );
    if (!result.rowCount) return res.redirect('/admin/login');
    next();
  } catch (error) { next(error); }
}

function csrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const supplied = String(req.headers['x-csrf-token'] || '');
  if (!supplied || supplied !== req.admin.csrf_token) {
    return res.status(403).json({ error: '安全校验失败，请刷新页面' });
  }
  next();
}

function adminApi(handler) {
  return [adminNetwork, sessionAuth, csrf, async (req, res, next) => {
    try { await handler(req, res); } catch (error) { next(error); }
  }];
}

async function createSession(userId, req, res) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  await pool.query(
    `INSERT INTO sessions(id_hash, user_id, csrf_token, ip_digest, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' hours')::interval)`,
    [
      digest(token), userId, csrfToken, digest(extractClientIp(req)),
      String(req.headers['user-agent'] || '').slice(0, 300), String(sessionHours)
    ]
  );
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `cv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionHours * 3600}${secure}`);
  return csrfToken;
}

async function ensureAdmin() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (result.rows[0].count > 0) return;
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!validEmail(email) || password.length < 8 || password.startsWith('replace-')) {
    throw new Error('Set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of at least 8 characters before first boot');
  }
  const passwordHash = await hashPassword(password);
  await pool.query('INSERT INTO users(email, password_hash) VALUES ($1, $2)', [email, passwordHash]);
  console.log(`Initial administrator created: ${email}`);
}

async function testImap({ email, password, host = 'imap.mail.me.com', port: imapPort = 993, secure = true }) {
  const client = new ImapFlow({
    host, port: Number(imapPort), secure: Boolean(secure),
    auth: { user: email, pass: password },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
  } finally {
    if (client.usable) await client.logout().catch(() => {});
  }
}

app.get('/health', async (_req, res) => {
  noStore(res);
  try {
    await pool.query('SELECT 1');
    const worker = await pool.query("SELECT status, heartbeat_at FROM runtime_status WHERE service = 'worker'");
    const heartbeat = worker.rows[0]?.heartbeat_at;
    const workerHealthy = heartbeat && Date.now() - new Date(heartbeat).getTime() < workerFreshSeconds * 1000;
    res.json({ ok: true, database: 'ok', worker: workerHealthy ? worker.rows[0].status : 'stale' });
  } catch (_error) {
    res.status(503).json({ ok: false, database: 'error', worker: 'unknown' });
  }
});
app.get('/', (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('/admin/login', adminNetwork, (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
app.get('/admin', adminNetwork, adminPageAuth, (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.post('/api/query', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`query:${ip}`, queryLimit, 10 * 60 * 1000);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: `请求过于频繁，请在 ${limit.retryAfter} 秒后重试` });
  }
  try {
    const failure = await failureGuard('query_failed', ip, queryFailureLimit);
    if (!failure.allowed) {
      res.set('Retry-After', String(failure.retryAfter));
      return res.status(429).json({ error: `查询密钥连续错误次数过多，请在 ${failure.retryAfter} 秒后重试` });
    }
    const token = String(req.body.token || '').trim();
    if (token.length < 20 || token.length > 200) {
      await audit({ actor: 'public', action: 'query_failed', ip, detail: 'invalid token format' });
      return res.status(401).json({ error: '查询密钥无效或已失效' });
    }
    const alias = await findPublicAlias(token);
    if (!alias) {
      await audit({ actor: 'public', action: 'query_failed', ip, detail: 'unknown token' });
      return res.status(401).json({ error: '查询密钥无效或已失效' });
    }
    const page = Math.max(1, Math.min(1000000, Number.parseInt(req.body.page, 10) || 1));
    const pageSize = Math.max(1, Math.min(50, Number.parseInt(req.body.pageSize, 10) || mailPageSize));
    const offset = (page - 1) * pageSize;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM verification_messages
       WHERE alias_id = $1 AND mail_expires_at > NOW()`,
      [alias.id]
    );
    const messageResult = await pool.query(
      `SELECT id, sender, subject, body_text_encrypted, code_encrypted, code_masked,
              confidence, received_at, expires_at, mail_expires_at
       FROM verification_messages
       WHERE alias_id = $1 AND mail_expires_at > NOW()
       ORDER BY received_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [alias.id, pageSize, offset]
    );
    await audit({ actor: `alias:${alias.id}`, action: 'query_success', target: String(alias.id), ip });
    const total = countResult.rows[0]?.total || 0;
    const messages = messageResult.rows.map((row) => ({
      ...mailMessageResponse(row),
      bodyPreview: row.body_text_encrypted ? String(decrypt(row.body_text_encrypted) || '').slice(0, 320) : ''
    }));
    const message = messages.find((item) => item.code && new Date(item.expiresAt).getTime() > Date.now()) || null;
    return res.json({
      alias: maskEmail(alias.address),
      label: alias.label,
      message,
      messages,
      pagination: { page, pageSize, total, hasMore: offset + messages.length < total }
    });
  } catch (error) { next(error); }
});

app.post('/api/query/message', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`query-message:${ip}`, queryLimit, 10 * 60 * 1000);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: '请求过于频繁，请稍后重试' });
  }
  try {
    const token = String(req.body.token || '').trim();
    const messageId = Number.parseInt(req.body.messageId, 10);
    if (token.length < 20 || token.length > 200 || !Number.isSafeInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: '查询参数无效' });
    }
    const alias = await findPublicAlias(token);
    if (!alias) return res.status(401).json({ error: '查询密钥无效或已失效' });
    const result = await pool.query(
      `SELECT id, sender, subject, body_text_encrypted, code_encrypted, code_masked,
              confidence, received_at, expires_at, mail_expires_at
       FROM verification_messages
       WHERE id = $1 AND alias_id = $2 AND mail_expires_at > NOW()`,
      [messageId, alias.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: '邮件不存在或已过期' });
    await audit({ actor: `alias:${alias.id}`, action: 'query_message_success', target: String(messageId), ip });
    return res.json({ message: mailMessageResponse(result.rows[0], true) });
  } catch (error) { next(error); }
});

app.post('/api/query/batch', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`query-batch:${ip}`, batchQueryLimit, 10 * 60 * 1000);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: `批量查询过于频繁，请在 ${limit.retryAfter} 秒后重试` });
  }
  try {
    const failure = await failureGuard('query_batch_failed', ip, queryFailureLimit);
    if (!failure.allowed) {
      res.set('Retry-After', String(failure.retryAfter));
      return res.status(429).json({ error: `无效查询密钥过多，请在 ${failure.retryAfter} 秒后重试` });
    }
    if (!Array.isArray(req.body.tokens) || !req.body.tokens.length) {
      return res.status(400).json({ error: '请至少输入一个查询密钥' });
    }
    if (req.body.tokens.length > 50) {
      return res.status(400).json({ error: '每次最多查询 50 个密钥' });
    }

    const tokens = req.body.tokens.map((value) => String(value || '').trim());
    const tokenDigests = tokens.map((token) => token.length >= 20 && token.length <= 200 ? digest(token) : null);
    const searchableDigests = [...new Set(tokenDigests.filter(Boolean))];
    const matched = searchableDigests.length ? await pool.query(
      `SELECT a.id, a.address, a.label, a.token_digest,
         v.id AS message_id, v.sender, v.subject, v.code_encrypted, v.received_at, v.expires_at,
         v.mail_expires_at
       FROM aliases a
       LEFT JOIN LATERAL (
         SELECT id, sender, subject, code_encrypted, received_at, expires_at, mail_expires_at
         FROM verification_messages
         WHERE alias_id = a.id AND mail_expires_at > NOW() AND expires_at > NOW() AND code_encrypted IS NOT NULL
         ORDER BY received_at DESC LIMIT 1
       ) v ON TRUE
       WHERE a.token_digest = ANY($1::text[]) AND a.enabled = TRUE
         AND (a.token_expires_at IS NULL OR a.token_expires_at > NOW())`,
      [searchableDigests]
    ) : { rows: [] };
    const aliasesByDigest = new Map(matched.rows.map((row) => [row.token_digest, row]));
    const results = tokens.map((_token, index) => {
      const alias = aliasesByDigest.get(tokenDigests[index]);
      if (!alias) return { index, status: 'invalid', alias: null, label: '', message: null };
      const message = alias.message_id ? {
        id: alias.message_id,
        code: decrypt(alias.code_encrypted),
        sender: alias.sender,
        subject: alias.subject,
        receivedAt: alias.received_at,
        expiresAt: alias.expires_at
      } : null;
      return {
        index,
        status: message ? 'received' : 'waiting',
        alias: maskEmail(alias.address),
        label: alias.label,
        message
      };
    });
    const invalidCount = results.filter((item) => item.status === 'invalid').length;
    await audit({
      actor: 'public',
      action: invalidCount === results.length ? 'query_batch_failed' : 'query_batch_success',
      ip,
      detail: `requested=${results.length};invalid=${invalidCount}`
    });
    return res.json({ results, refreshAfterSeconds: 15 });
  } catch (error) { next(error); }
});

app.post('/api/query/totp', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`query-totp-code:${ip}`, 60, 10 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '2FA 查询过于频繁，请稍后再试' });
  try {
    const failure = await failureGuard('totp_failed', ip, 20);
    if (!failure.allowed) {
      res.set('Retry-After', String(failure.retryAfter));
      return res.status(429).json({ error: `无效 2FA 密钥输入次数过多，请在 ${failure.retryAfter} 秒后重试` });
    }
    const requested = Array.isArray(req.body.entries)
      ? req.body.entries.slice(0, 50)
      : [{ secret: req.body.secret, issuer: req.body.issuer, accountName: req.body.accountName }];
    if (!requested.length) return res.status(400).json({ error: '请输入至少一个 2FA 密钥' });
    const converted = [];
    for (const item of requested) {
      const saved = await saveStandaloneTotp(item.secret, item.issuer, item.accountName);
      converted.push(totpEntryResponse(saved.entry, saved.secret));
    }
    await audit({ actor: 'public', action: 'totp_converted', target: converted.map((item) => item.id).join(','), ip });
    res.json({ totps: converted });
  } catch (error) {
    if (/TOTP|HOTP|2FA|Base32|otpauth/.test(error.message || '')) {
      await audit({ actor: 'public', action: 'totp_failed', ip, detail: 'invalid input' });
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post('/api/admin/login', adminNetwork, async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`login:${ip}`, loginLimit, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '登录尝试过多，请稍后再试' });
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const failure = await failureGuard('login_failed', ip, loginFailureLimit);
    if (!failure.allowed) {
      res.set('Retry-After', String(failure.retryAfter));
      return res.status(429).json({ error: `登录失败次数过多，请在 ${failure.retryAfter} 秒后重试` });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      await audit({ actor: email || 'unknown', action: 'login_failed', ip });
      return res.status(401).json({ error: '邮箱或密码不正确' });
    }
    if (user.totp_secret_encrypted) {
      const challenge = randomToken(24);
      await pool.query(
        `INSERT INTO login_challenges(id_hash, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
        [digest(challenge), user.id]
      );
      return res.json({ requiresTotp: true, challenge });
    }
    await createSession(user.id, req, res);
    await audit({ actor: `user:${user.id}`, action: 'login_success', ip });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/login/totp', adminNetwork, async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`login-totp:${ip}`, loginLimit, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '动态验证码尝试过多，请稍后再试' });
  try {
    const challenge = String(req.body.challenge || '');
    const code = String(req.body.code || '').replace(/\s/g, '');
    const result = await pool.query(
      `SELECT c.user_id, u.totp_secret_encrypted FROM login_challenges c
       JOIN users u ON u.id = c.user_id
       WHERE c.id_hash = $1 AND c.expires_at > NOW()`,
      [digest(challenge)]
    );
    if (!result.rowCount || !authenticator.check(code, decrypt(result.rows[0].totp_secret_encrypted))) {
      await audit({ actor: 'admin-challenge', action: 'login_totp_failed', ip });
      return res.status(401).json({ error: '动态验证码不正确' });
    }
    await pool.query('DELETE FROM login_challenges WHERE id_hash = $1', [digest(challenge)]);
    await createSession(result.rows[0].user_id, req, res);
    await audit({ actor: `user:${result.rows[0].user_id}`, action: 'login_totp_success', ip });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/state', ...adminApi(async (req, res) => {
  noStore(res);
  const currentSessionHash = digest(req.sessionToken);
  const [accounts, aliases, totpEntries, recent, unmatched, auditResult, metrics, runtime, sessions] = await Promise.all([
    pool.query(`SELECT id, email, provider, host, port, secure, enabled, status, last_error, last_synced_at, sync_requested_at, created_at FROM mail_accounts ORDER BY id`),
    pool.query(`SELECT a.id, a.mail_account_id, a.address, a.label, a.enabled, a.token_hint, a.token_expires_at, a.created_at,
      (a.token_encrypted IS NOT NULL) AS token_recoverable,
      (SELECT received_at FROM verification_messages v WHERE v.alias_id = a.id ORDER BY received_at DESC LIMIT 1) AS last_received_at
      FROM aliases a ORDER BY a.id DESC`),
    pool.query(`SELECT id, secret_hint, issuer, account_name, legacy_alias_address, last_used_at, created_at
      FROM totp_entries ORDER BY id DESC`),
    pool.query(`SELECT v.id, v.alias_id, a.address, v.sender, v.subject, v.code_masked, v.confidence, v.received_at, v.expires_at
      FROM verification_messages v LEFT JOIN aliases a ON a.id = v.alias_id ORDER BY v.received_at DESC LIMIT 50`),
    pool.query(`SELECT id, sender, subject, recipient_headers, received_at FROM unmatched_messages ORDER BY received_at DESC LIMIT 30`),
    pool.query(`SELECT actor, action, target, detail, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100`),
    pool.query(`SELECT
      COUNT(*) FILTER (WHERE action = 'query_success' AND created_at >= CURRENT_DATE)::int AS queries_today,
      COUNT(*) FILTER (WHERE action = 'query_failed' AND created_at >= CURRENT_DATE)::int AS query_failures_today,
      COUNT(*) FILTER (WHERE action = 'totp_converted' AND created_at >= CURRENT_DATE)::int AS totp_conversions_today,
      COUNT(*) FILTER (WHERE action = 'login_failed' AND created_at >= CURRENT_DATE)::int AS login_failures_today
      FROM audit_logs`),
    pool.query(
      `SELECT service, status, detail, heartbeat_at,
        heartbeat_at > NOW() - ($1::text || ' seconds')::interval AS fresh
       FROM runtime_status ORDER BY service`,
      [String(workerFreshSeconds)]
    ),
    pool.query(`SELECT session_id, user_agent, created_at, expires_at, (id_hash = $1) AS current
      FROM sessions WHERE user_id = $2 AND expires_at > NOW() ORDER BY created_at DESC`, [currentSessionHash, req.admin.id])
  ]);
  res.json({
    csrfToken: req.admin.csrf_token,
    admin: { email: req.admin.email, totpEnabled: Boolean(req.admin.totp_secret_encrypted) },
    accounts: accounts.rows,
    aliases: aliases.rows,
    totpEntries: totpEntries.rows,
    recent: recent.rows,
    unmatched: unmatched.rows,
    audit: auditResult.rows,
    metrics: metrics.rows[0],
    runtime: runtime.rows,
    sessions: sessions.rows
  });
}));

app.post('/api/admin/mail-account/:id/sync', ...adminApi(async (req, res) => {
  const result = await pool.query(
    `UPDATE mail_accounts SET sync_requested_at = NOW(), status = 'pending', updated_at = NOW()
     WHERE id = $1 AND enabled = TRUE RETURNING email`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '母邮箱不存在或已停用' });
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_sync_requested', target: result.rows[0].email, ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.delete('/api/admin/sessions/:id', ...adminApi(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM sessions WHERE session_id = $1 AND user_id = $2 AND id_hash <> $3 RETURNING session_id',
    [req.params.id, req.admin.id, digest(req.sessionToken)]
  );
  if (!result.rowCount) return res.status(404).json({ error: '会话不存在或不能撤销当前会话' });
  await audit({ actor: `user:${req.admin.id}`, action: 'session_revoked', target: String(result.rows[0].session_id), ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/sessions/revoke-others', ...adminApi(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2',
    [req.admin.id, digest(req.sessionToken)]
  );
  await audit({ actor: `user:${req.admin.id}`, action: 'other_sessions_revoked', detail: String(result.rowCount), ip: extractClientIp(req) });
  res.json({ ok: true, revoked: result.rowCount });
}));

app.post('/api/admin/mail-account', ...adminApi(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const appPassword = String(req.body.appPassword || '').trim();
  const config = mailAccountConfig(req.body);
  if (!validEmail(email) || appPassword.length < 8) {
    return res.status(400).json({ error: '请填写有效的邮箱和授权密码' });
  }
  await testImap({ email, password: appPassword, ...config });
  const result = await pool.query(
    `INSERT INTO mail_accounts(email, provider, app_password_encrypted, host, port, secure, status, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, 'connected', NULL)
     ON CONFLICT (email) DO UPDATE SET app_password_encrypted = EXCLUDED.app_password_encrypted,
       provider = EXCLUDED.provider, host = EXCLUDED.host, port = EXCLUDED.port,
       secure = EXCLUDED.secure, enabled = TRUE,
       status = 'connected', last_error = NULL, updated_at = NOW()
     RETURNING id, email, provider`,
    [email, config.provider, encrypt(appPassword), config.host, config.port, config.secure]
  );
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_saved', target: email, ip: extractClientIp(req) });
  res.json({ ok: true, account: result.rows[0] });
}));

app.patch('/api/admin/mail-account/:id', ...adminApi(async (req, res) => {
  const current = await pool.query('SELECT * FROM mail_accounts WHERE id = $1', [req.params.id]);
  if (!current.rowCount) return res.status(404).json({ error: '母邮箱不存在' });
  const email = normalizeEmail(req.body.email);
  const config = mailAccountConfig(req.body, current.rows[0]);
  const suppliedPassword = String(req.body.appPassword || '').trim();
  if (suppliedPassword && suppliedPassword.length < 8) {
    return res.status(400).json({ error: '邮箱授权密码至少需要 8 个字符' });
  }
  if (config.provider !== current.rows[0].provider && !suppliedPassword) {
    return res.status(400).json({ error: '切换邮箱服务商时需要填写对应的新授权密码' });
  }
  const appPassword = suppliedPassword || decrypt(current.rows[0].app_password_encrypted);
  if (!validEmail(email)) {
    return res.status(400).json({ error: '请填写有效的邮箱地址' });
  }
  await testImap({ email, password: appPassword, ...config });
  const result = await pool.query(
    `UPDATE mail_accounts SET email = $1, provider = $2, host = $3, port = $4,
       secure = $5, app_password_encrypted = $6, status = 'connected', last_error = NULL,
       updated_at = NOW() WHERE id = $7 RETURNING id, email, provider`,
    [email, config.provider, config.host, config.port, config.secure,
      suppliedPassword ? encrypt(suppliedPassword) : current.rows[0].app_password_encrypted, req.params.id]
  );
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_edited', target: result.rows[0].email, ip: extractClientIp(req) });
  res.json({ ok: true, account: result.rows[0] });
}));

app.post('/api/admin/mail-account/:id/secrets', ...adminApi(async (req, res) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`admin-mail-secret:${req.admin.id}:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '敏感信息查看过于频繁，请稍后再试' });

  const passwordResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.admin.id]);
  if (!passwordResult.rowCount || !(await verifyPassword(String(req.body.password || ''), passwordResult.rows[0].password_hash))) {
    await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_secret_reveal_failed', target: String(req.params.id), ip });
    return res.status(403).json({ error: '当前管理员密码不正确' });
  }

  const result = await pool.query(
    `SELECT email, provider, host, port, app_password_encrypted
     FROM mail_accounts WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '母邮箱不存在' });
  const account = result.rows[0];
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_secret_revealed', target: account.email, ip });
  res.json({
    email: account.email,
    provider: account.provider,
    host: account.host,
    port: account.port,
    appPassword: decrypt(account.app_password_encrypted)
  });
}));

app.post('/api/admin/mail-account/:id/toggle', ...adminApi(async (req, res) => {
  const result = await pool.query('UPDATE mail_accounts SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING email, enabled', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: '母邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_toggled', target: result.rows[0].email, ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.delete('/api/admin/mail-account/:id', ...adminApi(async (req, res) => {
  const result = await pool.query('DELETE FROM mail_accounts WHERE id = $1 RETURNING email', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: '母邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_account_deleted', target: result.rows[0].email, ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/aliases', ...adminApi(async (req, res) => {
  const address = normalizeEmail(req.body.address);
  const label = String(req.body.label || '').trim().slice(0, 80);
  const accountId = Number(req.body.mailAccountId);
  const expiresDays = req.body.expiresDays ? Math.max(1, Math.min(3650, Number(req.body.expiresDays))) : null;
  if (!validEmail(address) || !accountId) return res.status(400).json({ error: '请填写有效的子邮箱' });
  const token = `cv_${randomToken(24)}`;
  const result = await pool.query(
    `INSERT INTO aliases(mail_account_id, address, label, token_digest, token_encrypted, token_hint, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6,
       CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + ($7::text || ' days')::interval END)
     RETURNING id, address`,
    [accountId, address, label, digest(token), encrypt(token), token.slice(-6), expiresDays]
  );
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_created', target: address, ip: extractClientIp(req) });
  res.status(201).json({ ok: true, alias: result.rows[0], token });
}));

app.patch('/api/admin/aliases/:id', ...adminApi(async (req, res) => {
  const address = normalizeEmail(req.body.address);
  const label = String(req.body.label || '').trim().slice(0, 80);
  const accountId = Number(req.body.mailAccountId);
  const expiryMode = String(req.body.expiryMode || 'keep');
  const expiresDays = Math.max(1, Math.min(3650, Number(req.body.expiresDays || 30)));
  if (!validEmail(address) || !accountId || !['keep', 'never', 'days'].includes(expiryMode)) {
    return res.status(400).json({ error: '请填写有效的子邮箱配置' });
  }
  const result = await pool.query(
    `UPDATE aliases SET mail_account_id = $1, address = $2, label = $3,
       token_expires_at = CASE
         WHEN $4 = 'keep' THEN token_expires_at
         WHEN $4 = 'never' THEN NULL
         ELSE NOW() + ($5::text || ' days')::interval
       END,
       updated_at = NOW()
     WHERE id = $6 RETURNING id, address`,
    [accountId, address, label, expiryMode, String(expiresDays), req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '子邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_edited', target: address, ip: extractClientIp(req) });
  res.json({ ok: true, alias: result.rows[0] });
}));

app.get('/api/admin/aliases/export', ...adminApi(async (req, res) => {
  noStore(res);
  const result = await pool.query(
    `SELECT a.address, a.token_encrypted
     FROM aliases a JOIN mail_accounts m ON m.id = a.mail_account_id
     ORDER BY m.email, a.address`
  );
  const aliases = [];
  let skipped = 0;
  for (const row of result.rows) {
    if (!row.token_encrypted) {
      skipped += 1;
      continue;
    }
    try {
      aliases.push({ address: row.address, token: decrypt(row.token_encrypted) });
    } catch (_error) {
      skipped += 1;
    }
  }
  await audit({ actor: `user:${req.admin.id}`, action: 'aliases_exported', detail: `exported=${aliases.length};skipped=${skipped}`, ip: extractClientIp(req) });
  res.json({ aliases, skipped });
}));

app.post('/api/admin/aliases/import', ...adminApi(async (req, res) => {
  const accountId = Number(req.body.mailAccountId);
  const requested = Array.isArray(req.body.aliases) ? req.body.aliases.slice(0, 500) : [];
  const account = await pool.query('SELECT id, email FROM mail_accounts WHERE id = $1', [accountId]);
  if (!account.rowCount) return res.status(400).json({ error: '请选择有效的母邮箱' });
  if (!requested.length) return res.status(400).json({ error: '请提供至少一个子邮箱' });

  const created = [];
  const skipped = [];
  for (const item of requested) {
    const address = normalizeEmail(typeof item === 'string' ? item : item.address);
    const label = String(typeof item === 'string' ? '' : item.label || '').trim().slice(0, 80);
    if (!validEmail(address)) {
      skipped.push({ address, reason: '邮箱格式无效' });
      continue;
    }
    const token = `cv_${randomToken(24)}`;
    const result = await pool.query(
      `INSERT INTO aliases(mail_account_id, address, label, token_digest, token_encrypted, token_hint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO NOTHING RETURNING id, address`,
      [accountId, address, label, digest(token), encrypt(token), token.slice(-6)]
    );
    if (result.rowCount) created.push({ address, token });
    else skipped.push({ address, reason: '子邮箱已存在' });
  }
  await audit({ actor: `user:${req.admin.id}`, action: 'aliases_imported', target: account.rows[0].email, detail: `created=${created.length};skipped=${skipped.length}`, ip: extractClientIp(req) });
  res.status(201).json({ ok: true, created, skipped });
}));

app.post('/api/admin/aliases/:id/regenerate', ...adminApi(async (req, res) => {
  const token = `cv_${randomToken(24)}`;
  const result = await pool.query(
    `UPDATE aliases SET token_digest = $1, token_encrypted = $2, token_hint = $3,
     enabled = TRUE, updated_at = NOW() WHERE id = $4 RETURNING address`,
    [digest(token), encrypt(token), token.slice(-6), req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '子邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_token_regenerated', target: result.rows[0].address, ip: extractClientIp(req) });
  res.json({ ok: true, token });
}));

app.post('/api/admin/aliases/:id/toggle', ...adminApi(async (req, res) => {
  const result = await pool.query('UPDATE aliases SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING address, enabled', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: '子邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_toggled', target: result.rows[0].address, ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/aliases/:id/secrets', ...adminApi(async (req, res) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`admin-secret:${req.admin.id}:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '敏感信息查看过于频繁，请稍后再试' });

  const password = String(req.body.password || '');
  const passwordResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.admin.id]);
  if (!passwordResult.rowCount || !(await verifyPassword(password, passwordResult.rows[0].password_hash))) {
    await audit({ actor: `user:${req.admin.id}`, action: 'alias_secrets_reveal_failed', target: String(req.params.id), ip });
    return res.status(403).json({ error: '当前管理员密码不正确' });
  }

  const result = await pool.query(
    `SELECT address, token_encrypted FROM aliases WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '子邮箱不存在' });
  const alias = result.rows[0];
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_secrets_revealed', target: alias.address, ip });
  res.json({
    address: alias.address,
    queryToken: decrypt(alias.token_encrypted),
    queryTokenRecoverable: Boolean(alias.token_encrypted)
  });
}));

app.post('/api/admin/totp-entries/:id/secrets', ...adminApi(async (req, res) => {
  noStore(res);
  const ip = extractClientIp(req);
  const limit = rateLimit(`admin-totp-secret:${req.admin.id}:${ip}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: '敏感信息查看过于频繁，请稍后再试' });

  const passwordResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.admin.id]);
  if (!passwordResult.rowCount || !(await verifyPassword(String(req.body.password || ''), passwordResult.rows[0].password_hash))) {
    await audit({ actor: `user:${req.admin.id}`, action: 'totp_secret_reveal_failed', target: String(req.params.id), ip });
    return res.status(403).json({ error: '当前管理员密码不正确' });
  }

  const result = await pool.query(
    `SELECT id, secret_encrypted, issuer, account_name, legacy_alias_address
     FROM totp_entries WHERE id = $1`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '2FA 记录不存在' });
  const entry = result.rows[0];
  const secret = decrypt(entry.secret_encrypted);
  await audit({ actor: `user:${req.admin.id}`, action: 'totp_secret_revealed', target: String(entry.id), ip });
  res.json({
    ...totpEntryResponse(entry, secret),
    secret,
    legacyAliasAddress: entry.legacy_alias_address || ''
  });
}));

app.patch('/api/admin/totp-entries/:id', ...adminApi(async (req, res) => {
  const issuer = String(req.body.issuer || '').trim().slice(0, 120);
  const accountName = String(req.body.accountName || '').trim().slice(0, 160);
  const result = await pool.query(
    `UPDATE totp_entries SET issuer = $1, account_name = $2, updated_at = NOW()
     WHERE id = $3 RETURNING id`,
    [issuer, accountName, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '2FA 记录不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'totp_entry_edited', target: String(result.rows[0].id), ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.delete('/api/admin/totp-entries/:id', ...adminApi(async (req, res) => {
  const result = await pool.query('DELETE FROM totp_entries WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: '2FA 记录不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'totp_entry_deleted', target: String(result.rows[0].id), ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.delete('/api/admin/aliases/:id', ...adminApi(async (req, res) => {
  const result = await pool.query('DELETE FROM aliases WHERE id = $1 RETURNING address', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: '子邮箱不存在' });
  await audit({ actor: `user:${req.admin.id}`, action: 'alias_deleted', target: result.rows[0].address, ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/totp/setup', ...adminApi(async (req, res) => {
  if (req.admin.totp_secret_encrypted) return res.status(409).json({ error: 'TOTP 已启用' });
  const secret = authenticator.generateSecret();
  const uri = authenticator.keyuri(req.admin.email, 'iCloud Code Vault', secret);
  const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  res.json({ secret, qrDataUrl });
}));

app.post('/api/admin/totp/enable', ...adminApi(async (req, res) => {
  const secret = String(req.body.secret || '');
  const code = String(req.body.code || '');
  if (!secret || !authenticator.check(code, secret)) return res.status(400).json({ error: '动态验证码不正确' });
  await pool.query('UPDATE users SET totp_secret_encrypted = $1, updated_at = NOW() WHERE id = $2', [encrypt(secret), req.admin.id]);
  await audit({ actor: `user:${req.admin.id}`, action: 'totp_enabled', ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/password', ...adminApi(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少需要 8 个字符' });
  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.admin.id]);
  if (!(await verifyPassword(currentPassword, result.rows[0].password_hash))) return res.status(401).json({ error: '当前密码不正确' });
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [await hashPassword(newPassword), req.admin.id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [req.admin.id, digest(req.sessionToken)]);
  await audit({ actor: `user:${req.admin.id}`, action: 'password_changed', ip: extractClientIp(req) });
  res.json({ ok: true });
}));

app.post('/api/admin/logout', ...adminApi(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE id_hash = $1', [digest(req.sessionToken)]);
  res.setHeader('Set-Cookie', 'cv_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
}));

app.use((error, req, res, _next) => {
  console.error(error);
  noStore(res);
  if (error.code === '23505') {
    const message = error.constraint === 'mail_accounts_email_key'
      ? '该母邮箱已经存在'
      : error.constraint === 'aliases_address_key'
        ? '该子邮箱已经存在'
        : '相同记录已经存在';
    return res.status(409).json({ error: message });
  }
  if (error.code === '23503') {
    return res.status(400).json({ error: '关联的母邮箱不存在或已被删除' });
  }
  if (error.message === 'UNSUPPORTED_MAIL_PROVIDER') {
    return res.status(400).json({ error: '目前只支持 iCloud、Gmail 和 Outlook 邮箱' });
  }
  const known = /authentication|login|credentials/i.test(error.message || '');
  res.status(known ? 400 : 500).json({ error: known ? '邮箱 IMAP 登录失败，请检查邮箱、授权密码以及服务商是否允许 IMAP 登录' : '服务器处理失败' });
});

async function start() {
  await initDatabase();
  await ensureAdmin();
  await cleanExpired();
  setInterval(() => cleanExpired().catch(console.error), 60 * 60 * 1000).unref();
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
  }, 10 * 60 * 1000).unref();
  app.listen(port, '0.0.0.0', () => console.log(`Web server listening on port ${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
