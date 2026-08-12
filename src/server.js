'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { ImapFlow } = require('imapflow');
const QRCode = require('qrcode');
const { authenticator } = require('otplib');
const { parseTotpInput, generateTotp } = require('./totp');
const { extractBodyText, publicSenderText } = require('./extract');
const {
  pool, initDatabase, randomToken, digest, encrypt, decrypt, hashPassword,
  verifyPassword, normalizeEmail, validEmail, extractClientIp,
  audit, cleanExpired
} = require('./lib');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionHours = Number(process.env.SESSION_HOURS || 12);
const loginLimit = Number(process.env.LOGIN_LIMIT_PER_15_MINUTES || 10);
const mailPageSize = Math.max(1, Math.min(50, Number(process.env.MAIL_PAGE_SIZE || 20)));
const loginFailureLimit = Number(process.env.LOGIN_FAILURE_LIMIT_PER_15_MINUTES || 5);
const workerFreshSeconds = Math.max(90, Number(process.env.IMAP_POLL_SECONDS || 15) * 4);
const mailRetentionDays = Math.max(1, Math.min(30, Number(process.env.MAIL_RETENTION_DAYS || 7)));
const publicRefreshSeconds = Math.max(30, Math.min(300, Number(process.env.PUBLIC_MAIL_REFRESH_SECONDS || 60)));
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

function inferProvider(email, supplied = '') {
  const requested = String(supplied || '').trim().toLowerCase();
  if (mailProviders[requested]) return requested;
  const domain = normalizeEmail(email).split('@')[1] || '';
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return 'icloud';
  if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  return '';
}

function parseImportAccount(item) {
  const email = normalizeEmail(item?.email);
  const provider = inferProvider(email, item?.provider);
  const password = String(item?.password || item?.appPassword || '').trim();
  if (!validEmail(email)) return { email, provider, password, error: '邮箱格式无效' };
  if (!provider) return { email, provider, password, error: '无法识别邮箱服务商' };
  if (password.length < 8) return { email, provider, password, error: '授权密码至少需要 8 个字符' };
  return { email, provider, password, error: '' };
}

function importJobResponse(job, items = []) {
  const retryableStatuses = new Set(['login_failed', 'timeout', 'failed']);
  return {
    id: job.id,
    importType: job.import_type,
    total: job.total_count,
    waiting: job.waiting_count,
    validating: job.validating_count,
    syncing: job.syncing_count,
    succeeded: job.success_count,
    failed: job.failed_count,
    retryable: items.filter((item) => retryableStatuses.has(item.status)).length,
    status: job.status,
    createdAt: job.created_at,
    completedAt: job.completed_at,
    items: items.map((item) => ({
      id: item.id,
      email: item.email,
      provider: item.provider,
      status: item.status,
      failureReason: item.failure_reason || '',
      attemptCount: item.attempt_count,
      nextRetryAt: item.next_retry_at,
      completedAt: item.completed_at
    }))
  };
}

async function createMailImportItem(client, jobId, item, status = 'waiting', failureReason = '') {
  await client.query(
    `INSERT INTO mail_import_items(
       job_id, email, provider, app_password_encrypted, status, failure_reason, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'waiting' THEN NULL ELSE NOW() END)`,
    [
      jobId,
      item.email,
      item.provider || 'unknown',
      status === 'waiting' ? encrypt(item.password) : null,
      status,
      failureReason || null
    ]
  );
}

function adminMailMessageResponse(row) {
  return {
    id: row.id,
    folders: Array.isArray(row.mailbox_paths) ? row.mailbox_paths : [],
    mailbox: row.address || '未归类邮箱',
    sender: row.sender,
    recipients: decrypt(row.recipients_encrypted) || '',
    subject: row.subject,
    body: extractBodyText(decrypt(row.body_text_encrypted), ''),
    receivedAt: row.received_at
  };
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
    `SELECT a.id, a.address, a.token_expires_at,
            ma.enabled AS account_enabled, ma.status AS account_status,
            ma.last_synced_at
     FROM aliases a
     JOIN mail_accounts ma ON ma.id = a.mail_account_id
     WHERE a.token_digest = $1 AND a.enabled = TRUE
       AND (a.token_expires_at IS NULL OR a.token_expires_at > NOW())`,
    [digest(token)]
  );
  return result.rows[0] || null;
}

function normalizePublicToken(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  const direct = input.match(/^cv_[A-Za-z0-9_-]{17,197}$/);
  if (direct) return direct[0];
  const exported = input.match(/(?:^|--)\s*(cv_[A-Za-z0-9_-]{17,197})\s*$/);
  return exported ? exported[1] : '';
}

function publicMailboxResponse(alias, stats, runtime) {
  let state = 'updating';
  if (!alias.account_enabled) state = 'paused';
  else if (!runtime?.fresh) state = 'delayed';
  else if (alias.account_status === 'connected') state = 'ready';
  else if (alias.account_status === 'error') state = 'delayed';
  return {
    address: alias.address,
    state,
    lastSyncedAt: alias.last_synced_at,
    lastMessageAt: stats.latest_received_at,
    totalMessages: stats.total_count,
    retentionDays: mailRetentionDays,
    refreshAfterSeconds: publicRefreshSeconds
  };
}

function mailMessageResponse(message, includeBody = false) {
  const codeActive = message.code_encrypted && new Date(message.expires_at).getTime() > Date.now();
  return {
    id: message.id,
    folders: Array.isArray(message.mailbox_paths) ? message.mailbox_paths : [],
    sender: message.sender,
    subject: message.subject,
    body: includeBody ? extractBodyText(decrypt(message.body_text_encrypted), '') : null,
    bodyPreview: extractBodyText(message.body_preview, ''),
    code: codeActive ? decrypt(message.code_encrypted) : null,
    codeMasked: codeActive ? message.code_masked : null,
    confidence: message.confidence,
    receivedAt: message.received_at,
    expiresAt: message.expires_at,
    mailExpiresAt: message.mail_expires_at
  };
}

function publicMailMessageResponse(message) {
  return {
    id: message.id,
    sender: publicSenderText(message.sender),
    subject: message.subject,
    bodyPreview: extractBodyText(message.body_preview, ''),
    receivedAt: message.received_at
  };
}

function publicCodeMessageResponse(message) {
  return {
    id: message.id,
    sender: publicSenderText(message.sender),
    subject: message.subject,
    code: decrypt(message.code_encrypted) || '',
    codeMasked: message.code_masked || '',
    confidence: message.confidence,
    receivedAt: message.received_at,
    expiresAt: message.code_expires_at
  };
}

function parsePublicCursor(value) {
  if (!value) return { receivedAt: null, id: null };
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const id = Number(decoded.id);
    if (!decoded.receivedAt || !Number.isSafeInteger(id) || id < 1) throw new Error('invalid cursor');
    return { receivedAt: decoded.receivedAt, id };
  } catch (_error) {
    return null;
  }
}

function makePublicCursor(row) {
  return row ? Buffer.from(JSON.stringify({ receivedAt: row.received_at, id: row.id })).toString('base64url') : null;
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
  try {
    const token = normalizePublicToken(req.body.token);
    if (!token) {
      await audit({ actor: 'public', action: 'query_failed', ip, detail: 'invalid token format' });
      return res.status(401).json({ error: '查询密钥格式错误' });
    }
    const alias = await findPublicAlias(token);
    if (!alias) {
      await audit({ actor: 'public', action: 'query_failed', ip, detail: 'unknown token' });
      return res.status(401).json({ error: '查询密钥无效或已失效' });
    }
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.body.limit, 10) || 40));
    const keyword = String(req.body.keyword || '').trim().slice(0, 120);
    const codeOnly = String(req.body.status || '') === 'code';
    const cursor = parsePublicCursor(req.body.cursor);
    if (!cursor) return res.status(400).json({ error: '邮件游标无效' });
    const [messageResult, statsResult, runtimeResult] = await Promise.all([pool.query(
      `SELECT id, sender, subject, body_preview, received_at,
              code_encrypted, code_masked, confidence, code_expires_at
       FROM mail_messages
       WHERE alias_id = $1 AND mail_expires_at > NOW()
         AND ($2 = '' OR sender ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%'
              OR body_preview ILIKE '%' || $2 || '%')
         AND ($3::boolean = FALSE OR (code_encrypted IS NOT NULL AND code_expires_at > NOW()))
         AND ($4::timestamptz IS NULL OR (received_at, id) < ($4::timestamptz, $5::bigint))
       ORDER BY received_at DESC, id DESC LIMIT $6`,
      [alias.id, keyword, codeOnly, cursor.receivedAt, cursor.id, limit + 1]
    ), pool.query(
      `SELECT COUNT(*)::int AS total_count,
              MAX(received_at) AS latest_received_at
       FROM mail_messages
       WHERE alias_id = $1 AND mail_expires_at > NOW()`,
      [alias.id]
    ), pool.query(
      `SELECT status,
              heartbeat_at > NOW() - ($1::text || ' seconds')::interval AS fresh
       FROM runtime_status
       WHERE service = 'worker'`,
      [String(workerFreshSeconds)]
    )]);
    await audit({ actor: `alias:${alias.id}`, action: 'query_success', target: String(alias.id), ip });
    const messages = messageResult.rows.slice(0, limit).map(codeOnly ? publicCodeMessageResponse : publicMailMessageResponse);
    const hasMore = messageResult.rows.length > limit;
    return res.json({
      mailbox: publicMailboxResponse(alias, statsResult.rows[0], runtimeResult.rows[0]),
      messages,
      nextCursor: hasMore ? makePublicCursor(messageResult.rows[limit - 1]) : null
    });
  } catch (error) { next(error); }
});

app.post('/api/query/message', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  try {
    const token = normalizePublicToken(req.body.token);
    const messageId = Number.parseInt(req.body.messageId, 10);
    if (!token || !Number.isSafeInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: '查询参数无效' });
    }
    const alias = await findPublicAlias(token);
    if (!alias) return res.status(401).json({ error: '查询密钥无效或已失效' });
    const result = await pool.query(
      `SELECT id, sender, subject, body_text_encrypted,
              body_preview, received_at
       FROM mail_messages
       WHERE id = $1 AND alias_id = $2 AND mail_expires_at > NOW()`,
      [messageId, alias.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: '邮件不存在或已过期' });
    await audit({ actor: `alias:${alias.id}`, action: 'query_message_success', target: String(messageId), ip });
    const row = result.rows[0];
    const message = publicMailMessageResponse(row);
    message.body = extractBodyText(decrypt(row.body_text_encrypted), '');
    return res.json({ message });
  } catch (error) { next(error); }
});

app.post('/api/query/batch', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  try {
    if (!Array.isArray(req.body.tokens) || !req.body.tokens.length) {
      return res.status(400).json({ error: '请至少输入一个查询密钥' });
    }
    if (req.body.tokens.length > 50) {
      return res.status(400).json({ error: '每次最多查询 50 个密钥' });
    }

    const tokens = req.body.tokens.map(normalizePublicToken);
    const tokenDigests = tokens.map((token) => token ? digest(token) : null);
    const searchableDigests = [...new Set(tokenDigests.filter(Boolean))];
    const matched = searchableDigests.length ? await pool.query(
       `SELECT a.id, a.token_digest,
         v.id AS message_id, v.sender, v.subject, v.mailbox_paths, v.code_encrypted, v.received_at, v.expires_at,
         v.mail_expires_at
       FROM aliases a
       LEFT JOIN LATERAL (
         SELECT id, sender, subject, mailbox_paths, code_encrypted, received_at, expires_at, mail_expires_at
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
      if (!tokens[index]) return { index, status: 'invalid_format', message: null };
      if (!alias) return { index, status: 'invalid', message: null };
      const message = alias.message_id ? {
        id: alias.message_id,
        code: decrypt(alias.code_encrypted),
        sender: alias.sender,
        subject: alias.subject,
        folders: Array.isArray(alias.mailbox_paths) ? alias.mailbox_paths : [],
        receivedAt: alias.received_at,
        expiresAt: alias.expires_at
      } : null;
      return {
        index,
        status: message ? 'received' : 'waiting',
        message
      };
    });
    const invalidCount = results.filter((item) => item.status === 'invalid' || item.status === 'invalid_format').length;
    await audit({
      actor: 'public',
      action: invalidCount === results.length ? 'query_batch_failed' : 'query_batch_success',
      ip,
      detail: `requested=${results.length};invalid=${invalidCount}`
    });
    return res.json({ results, refreshAfterSeconds: 15 });
  } catch (error) { next(error); }
});

app.post('/api/query/batch-inbox', async (req, res, next) => {
  noStore(res);
  const ip = extractClientIp(req);
  try {
    if (!Array.isArray(req.body.tokens) || !req.body.tokens.length) {
      return res.status(400).json({ error: '请至少输入一个查询密钥' });
    }
    if (req.body.tokens.length > 50) {
      return res.status(400).json({ error: '每次最多查询50个密钥' });
    }
    const tokens = req.body.tokens.map(normalizePublicToken);
    const keyword = String(req.body.keyword || '').trim().slice(0, 120);
    const requestedLimit = Number.parseInt(req.body.limitPerMailbox, 10);
    const limitPerMailbox = Math.max(1, Math.min(50, requestedLimit || 20));
    const cursor = parsePublicCursor(req.body.cursor);
    if (!cursor) return res.status(400).json({ error: '邮件游标无效' });
    if (cursor.receivedAt && tokens.length !== 1) {
      return res.status(400).json({ error: '批量续页时每次只能加载一个邮箱' });
    }
    const tokenDigests = tokens.map((token) => token ? digest(token) : null);
    const searchableDigests = [...new Set(tokenDigests.filter(Boolean))];
    const matched = searchableDigests.length ? await pool.query(
      `SELECT a.id, a.address, a.token_digest,
              ma.enabled AS account_enabled, ma.status AS account_status,
              ma.last_synced_at
       FROM aliases a
       JOIN mail_accounts ma ON ma.id = a.mail_account_id
       WHERE a.token_digest = ANY($1::text[]) AND a.enabled = TRUE
         AND (a.token_expires_at IS NULL OR a.token_expires_at > NOW())`,
      [searchableDigests]
    ) : { rows: [] };
    const aliasesByDigest = new Map(matched.rows.map((row) => [row.token_digest, row]));
    const aliases = [...new Map(matched.rows.map((row) => [row.id, row])).values()];
    const aliasIds = aliases.map((alias) => alias.id);
    const runtimeResult = await pool.query(
      `SELECT status,
              heartbeat_at > NOW() - ($1::text || ' seconds')::interval AS fresh
       FROM runtime_status
       WHERE service = 'worker'`,
      [String(workerFreshSeconds)]
    );
    const runtime = runtimeResult.rows[0];

    let messageRows = [];
    let statsRows = [];
    if (aliasIds.length) {
      const [messagesResult, statsResult] = await Promise.all([
        pool.query(
          `SELECT id, alias_id, sender, subject, body_preview, received_at
           FROM (
             SELECT id, alias_id, sender, subject, body_preview, received_at,
                    ROW_NUMBER() OVER (PARTITION BY alias_id ORDER BY received_at DESC, id DESC) AS row_number
             FROM mail_messages
             WHERE alias_id = ANY($1::bigint[]) AND mail_expires_at > NOW()
               AND ($2 = '' OR sender ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%'
                    OR body_preview ILIKE '%' || $2 || '%')
               AND ($4::timestamptz IS NULL OR (received_at, id) < ($4::timestamptz, $5::bigint))
           ) recent
           WHERE row_number <= $3::int + 1
           ORDER BY alias_id, received_at DESC, id DESC`,
          [aliasIds, keyword, limitPerMailbox, cursor.receivedAt, cursor.id]
        ),
        pool.query(
          `SELECT alias_id,
                  COUNT(*)::int AS total_count,
                  COUNT(*) FILTER (
                    WHERE $2 = '' OR sender ILIKE '%' || $2 || '%' OR subject ILIKE '%' || $2 || '%'
                          OR body_preview ILIKE '%' || $2 || '%'
                  )::int AS matched_count,
                  MAX(received_at) AS latest_received_at
           FROM mail_messages
           WHERE alias_id = ANY($1::bigint[]) AND mail_expires_at > NOW()
           GROUP BY alias_id`,
          [aliasIds, keyword]
        )
      ]);
      messageRows = messagesResult.rows;
      statsRows = statsResult.rows;
    }
    const messageRowsByAlias = new Map();
    for (const row of messageRows) {
      if (!messageRowsByAlias.has(row.alias_id)) messageRowsByAlias.set(row.alias_id, []);
      messageRowsByAlias.get(row.alias_id).push(row);
    }
    const statsByAlias = new Map(statsRows.map((row) => [row.alias_id, row]));
    const results = tokens.map((_token, index) => {
      const alias = aliasesByDigest.get(tokenDigests[index]);
      if (!tokens[index]) return { index, status: 'invalid_format', mailbox: null, messages: [], nextCursor: null };
      if (!alias) return { index, status: 'invalid', mailbox: null, messages: [], nextCursor: null };
      const stats = statsByAlias.get(alias.id) || {
        total_count: 0, matched_count: 0, latest_received_at: null
      };
      const aliasMessageRows = messageRowsByAlias.get(alias.id) || [];
      const visibleRows = aliasMessageRows.slice(0, limitPerMailbox);
      const messages = visibleRows.map(publicMailMessageResponse);
      const lastRow = visibleRows.at(-1);
      const mailbox = publicMailboxResponse(alias, stats, runtime);
      mailbox.matchedMessages = stats.matched_count;
      return {
        index,
        status: messages.length ? 'ready' : 'empty',
        mailbox,
        messages,
        nextCursor: aliasMessageRows.length > limitPerMailbox && lastRow ? makePublicCursor(lastRow) : null
      };
    });
    const invalidCount = results.filter((item) => item.status === 'invalid' || item.status === 'invalid_format').length;
    await audit({
      actor: 'public',
      action: invalidCount === results.length ? 'query_batch_inbox_failed' : 'query_batch_inbox_success',
      ip,
      detail: `requested=${results.length};invalid=${invalidCount};keyword=${keyword ? 'yes' : 'no'}`
    });
    return res.json({ results, keyword, limitPerMailbox });
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
    pool.query(`SELECT mm.id, mm.alias_id, a.address, mm.sender, mm.subject, mm.mailbox_paths, mm.received_at
      FROM mail_messages mm LEFT JOIN aliases a ON a.id = mm.alias_id
      WHERE mm.mail_expires_at > NOW()
      ORDER BY mm.received_at DESC LIMIT 50`),
    pool.query(`SELECT id, sender, subject, mailbox_paths, recipient_headers, received_at FROM unmatched_messages ORDER BY received_at DESC LIMIT 30`),
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

app.post('/api/admin/mail-accounts/import', ...adminApi(async (req, res) => {
  const requested = Array.isArray(req.body.accounts) ? req.body.accounts : [];
  if (!requested.length) return res.status(400).json({ error: '请至少提供一个邮箱账户' });
  if (requested.length > 10) return res.status(400).json({ error: '每次最多批量导入 10 个母邮箱' });

  const parsed = requested.map(parseImportAccount);
  const seen = new Set();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `INSERT INTO mail_import_jobs(admin_id, import_type, total_count, waiting_count, status)
       VALUES ($1, 'mail_accounts', $2, $2, 'queued') RETURNING *`,
      [req.admin.id, parsed.length]
    );
    const job = jobResult.rows[0];
    for (const item of parsed) {
      const duplicateInFile = !item.error && seen.has(item.email);
      if (!item.error) seen.add(item.email);
      const status = item.error ? 'format_error' : duplicateInFile ? 'duplicate' : 'waiting';
      const failureReason = item.error || (duplicateInFile ? 'CSV 中存在重复邮箱' : '');
      await createMailImportItem(client, job.id, item, status, failureReason);
    }
    await client.query(
      `UPDATE mail_import_jobs j SET
         waiting_count = s.waiting_count, failed_count = s.failed_count,
         status = CASE WHEN s.waiting_count > 0 THEN 'queued' ELSE 'failed' END,
         completed_at = CASE WHEN s.waiting_count = 0 THEN NOW() ELSE NULL END
       FROM (
         SELECT job_id,
           COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting_count,
           COUNT(*) FILTER (WHERE status IN ('format_error', 'duplicate'))::int AS failed_count
         FROM mail_import_items WHERE job_id = $1 GROUP BY job_id
       ) s WHERE j.id = s.job_id`,
      [job.id]
    );
    await client.query('COMMIT');
    await audit({ actor: `user:${req.admin.id}`, action: 'mail_accounts_imported', target: String(job.id), detail: `requested=${parsed.length}`, ip: extractClientIp(req) });
    res.status(202).json({ ok: true, jobId: job.id, total: parsed.length });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/admin/mail-import-jobs/:id', ...adminApi(async (req, res) => {
  noStore(res);
  const [jobResult, itemsResult] = await Promise.all([
    pool.query('SELECT * FROM mail_import_jobs WHERE id = $1 AND admin_id = $2', [req.params.id, req.admin.id]),
    pool.query(
      `SELECT id, email, provider, status, failure_reason, attempt_count, next_retry_at, completed_at
       FROM mail_import_items
       WHERE job_id = $1
         AND EXISTS (
           SELECT 1 FROM mail_import_jobs j
           WHERE j.id = mail_import_items.job_id AND j.admin_id = $2
         )
       ORDER BY id`,
      [req.params.id, req.admin.id]
    )
  ]);
  if (!jobResult.rowCount) return res.status(404).json({ error: '导入任务不存在' });
  res.json(importJobResponse(jobResult.rows[0], itemsResult.rows));
}));

app.post('/api/admin/mail-import-jobs/:id/retry', ...adminApi(async (req, res) => {
  const job = await pool.query('SELECT id FROM mail_import_jobs WHERE id = $1 AND admin_id = $2', [req.params.id, req.admin.id]);
  if (!job.rowCount) return res.status(404).json({ error: '导入任务不存在' });
  const result = await pool.query(
    `UPDATE mail_import_items SET status = 'waiting', failure_reason = NULL,
       attempt_count = 0, next_retry_at = NULL, completed_at = NULL
     WHERE job_id = $1 AND status IN ('login_failed', 'timeout', 'failed') RETURNING id`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(400).json({ error: '没有可重试的失败项' });
  await pool.query(
    `UPDATE mail_import_jobs SET status = 'queued', waiting_count = $1,
     failed_count = GREATEST(0, failed_count - $1), completed_at = NULL WHERE id = $2`,
    [result.rowCount, req.params.id]
  );
  await audit({ actor: `user:${req.admin.id}`, action: 'mail_import_retried', target: String(req.params.id), detail: String(result.rowCount), ip: extractClientIp(req) });
  res.json({ ok: true, retried: result.rowCount });
}));

app.get('/api/admin/mailbox-tree', ...adminApi(async (req, res) => {
  noStore(res);
  const keyword = String(req.query.keyword || '').trim().toLowerCase().slice(0, 120);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT m.id, m.email, m.provider, m.enabled, m.verification_status, m.sync_status,
       m.last_error, m.last_synced_at,
       COUNT(DISTINCT a.id)::int AS alias_count,
       COUNT(DISTINCT mm.id)::int AS message_count
     FROM mail_accounts m
     LEFT JOIN aliases a ON a.mail_account_id = m.id
     LEFT JOIN mail_messages mm ON mm.mail_account_id = m.id AND mm.mail_expires_at > NOW()
     WHERE ($1 = '' OR LOWER(m.email) LIKE '%' || $1 || '%')
     GROUP BY m.id ORDER BY m.id DESC LIMIT $2 OFFSET $3`,
    [keyword, limit, offset]
  );
  res.json({ accounts: result.rows, pagination: { page, limit, hasMore: result.rows.length === limit } });
}));

app.get('/api/admin/messages', ...adminApi(async (req, res) => {
  noStore(res);
  const accountId = Number.parseInt(req.query.mailAccountId, 10) || null;
  const aliasId = Number.parseInt(req.query.aliasId, 10) || null;
  const keyword = String(req.query.keyword || '').trim().slice(0, 120);
  const codeOnly = req.query.status === 'code';
  const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 40));
  let cursorDate = null;
  let cursorId = null;
  if (req.query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
      cursorDate = decoded.receivedAt;
      cursorId = Number(decoded.id);
    } catch (_error) {
      return res.status(400).json({ error: '邮件游标无效' });
    }
  }
  const result = await pool.query(
    `SELECT mm.id, mm.alias_id, a.address, mm.sender, mm.subject, mm.body_preview, mm.mailbox_paths,
       mm.received_at
     FROM mail_messages mm
     LEFT JOIN aliases a ON a.id = mm.alias_id
     WHERE mm.mail_expires_at > NOW()
       AND ($1::bigint IS NULL OR mm.mail_account_id = $1)
       AND ($2::bigint IS NULL OR mm.alias_id = $2)
       AND ($3 = '' OR mm.sender ILIKE '%' || $3 || '%' OR mm.subject ILIKE '%' || $3 || '%'
            OR a.address ILIKE '%' || $3 || '%'
            OR array_to_string(mm.mailbox_paths, ', ') ILIKE '%' || $3 || '%')
       AND ($4::boolean = FALSE OR mm.code_encrypted IS NOT NULL)
       AND ($5::timestamptz IS NULL OR (mm.received_at, mm.id) < ($5::timestamptz, $6::bigint))
     ORDER BY mm.received_at DESC, mm.id DESC LIMIT $7`,
    [accountId, aliasId, keyword, codeOnly, cursorDate, cursorId, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  res.json({
    messages: rows.map((row) => ({
      id: row.id,
      folders: Array.isArray(row.mailbox_paths) ? row.mailbox_paths : [],
      mailbox: row.address || '未归类邮箱',
      sender: row.sender,
      subject: row.subject,
      bodyPreview: row.body_preview,
      receivedAt: row.received_at
    })),
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ receivedAt: last.received_at, id: last.id })).toString('base64url')
      : null
  });
}));

app.get('/api/admin/messages/:id', ...adminApi(async (req, res) => {
  noStore(res);
  const result = await pool.query(
    `SELECT mm.id, a.address, mm.sender, mm.recipients_encrypted, mm.subject, mm.mailbox_paths,
       mm.body_text_encrypted, mm.received_at
     FROM mail_messages mm LEFT JOIN aliases a ON a.id = mm.alias_id
     WHERE mm.id = $1 AND mm.mail_expires_at > NOW()`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: '邮件不存在或已过期' });
  const row = result.rows[0];
  await audit({ actor: `user:${req.admin.id}`, action: 'admin_message_opened', target: String(row.id), ip: extractClientIp(req) });
  res.json({ message: adminMailMessageResponse(row) });
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
  const mode = String(req.query.mode || 'new').trim().toLowerCase();
  if (!['new', 'all'].includes(mode)) return res.status(400).json({ error: '导出方式无效' });
  const result = await pool.query(
    `SELECT a.id, a.address, a.token_encrypted
     FROM aliases a JOIN mail_accounts m ON m.id = a.mail_account_id
     WHERE ($1 = 'all' OR a.exported_at IS NULL)
     ORDER BY m.email, a.address`
    , [mode]
  );
  const aliases = [];
  let skipped = 0;
  for (const row of result.rows) {
    if (!row.token_encrypted) {
      skipped += 1;
      continue;
    }
    try {
      aliases.push({ id: row.id, address: row.address, token: decrypt(row.token_encrypted) });
    } catch (_error) {
      skipped += 1;
    }
  }
  let exportToken = '';
  if (mode === 'new' && aliases.length) {
    exportToken = randomToken(24);
    await pool.query(
      `INSERT INTO alias_export_batches(id_hash, admin_id, alias_ids, expires_at)
       VALUES ($1, $2, $3::bigint[], NOW() + INTERVAL '30 minutes')`,
      [digest(exportToken), req.admin.id, aliases.map((row) => row.id)]
    );
  }
  await audit({ actor: `user:${req.admin.id}`, action: 'aliases_export_prepared', detail: `mode=${mode};exported=${aliases.length};skipped=${skipped}`, ip: extractClientIp(req) });
  res.json({ aliases: aliases.map(({ address, token }) => ({ address, token })), skipped, mode, exportToken });
}));

app.post('/api/admin/aliases/export/confirm', ...adminApi(async (req, res) => {
  const exportToken = String(req.body.exportToken || '').trim();
  const suppliedIds = Array.isArray(req.body.aliasIds)
    ? [...new Set(req.body.aliasIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    : [];
  if (!exportToken && !suppliedIds.length) return res.status(400).json({ error: '没有需要确认的导出记录' });
  if (suppliedIds.length > 100) return res.status(400).json({ error: '一次最多确认 100 个邮箱' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let aliasIds = suppliedIds;
    if (exportToken) {
      const batch = await client.query(
        `SELECT alias_ids FROM alias_export_batches
         WHERE id_hash = $1 AND admin_id = $2 AND expires_at > NOW()
         FOR UPDATE`,
        [digest(exportToken), req.admin.id]
      );
      if (!batch.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: '导出确认已过期，请重新导出' });
      }
      aliasIds = batch.rows[0].alias_ids.map(Number);
    }
    const updated = await client.query(
      `UPDATE aliases SET exported_at = NOW()
       WHERE id = ANY($1::bigint[]) AND exported_at IS NULL
       RETURNING id`,
      [aliasIds]
    );
    if (exportToken) {
      await client.query(
        'UPDATE alias_export_batches SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id_hash = $1',
        [digest(exportToken)]
      );
    }
    await client.query('COMMIT');
    await audit({ actor: `user:${req.admin.id}`, action: 'aliases_exported', detail: `exported=${updated.rowCount};skipped=0`, ip: extractClientIp(req) });
    res.json({ ok: true, confirmed: updated.rowCount });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/aliases/import', ...adminApi(async (req, res) => {
  const accountId = Number(req.body.mailAccountId);
  const requested = Array.isArray(req.body.aliases) ? req.body.aliases : [];
  const account = await pool.query('SELECT id, email FROM mail_accounts WHERE id = $1', [accountId]);
  if (!account.rowCount) return res.status(400).json({ error: '请选择有效的母邮箱' });
  if (!requested.length) return res.status(400).json({ error: '请提供至少一个子邮箱' });
  if (requested.length > 100) return res.status(400).json({ error: '每次最多批量导入 100 个邮箱' });

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
    if (result.rowCount) created.push({ id: result.rows[0].id, address, token });
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
