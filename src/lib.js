'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function requiredHex(name) {
  const value = process.env[name] || '';
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${name} must contain exactly 64 hexadecimal characters`);
  }
  return Buffer.from(value, 'hex');
}

const masterKey = requiredHex('MASTER_KEY_HEX');
const tokenPepper = requiredHex('TOKEN_PEPPER_HEX');

async function initDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const legacy = await pool.query(
    `SELECT id, address, totp_secret_encrypted, totp_issuer, totp_account_name
     FROM aliases WHERE totp_secret_encrypted IS NOT NULL`
  );
  for (const alias of legacy.rows) {
    const secret = decrypt(alias.totp_secret_encrypted);
    await pool.query(
      `INSERT INTO totp_entries(
         secret_encrypted, secret_fingerprint, secret_hint, issuer, account_name, legacy_alias_address
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (secret_fingerprint) DO NOTHING`,
      [alias.totp_secret_encrypted, digest(`totp:${secret}`), secret.slice(-4), alias.totp_issuer, alias.totp_account_name, alias.address]
    );
    await pool.query(
      `UPDATE aliases SET totp_secret_encrypted = NULL, totp_issuer = '',
       totp_account_name = '', updated_at = NOW() WHERE id = $1`,
      [alias.id]
    );
  }
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return crypto.createHmac('sha256', tokenPepper).update(String(value)).digest('hex');
}

function encrypt(value) {
  if (value === null || value === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decrypt(payload) {
  if (!payload) return null;
  const [version, ivPart, tagPart, bodyPart] = String(payload).split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !bodyPart) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) return reject(error);
      resolve(`scrypt$32768$${salt.toString('base64url')}$${key.toString('base64url')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [algorithm, n, saltPart, keyPart] = String(stored || '').split('$');
    if (algorithm !== 'scrypt' || !saltPart || !keyPart) return resolve(false);
    const expected = Buffer.from(keyPart, 'base64url');
    crypto.scrypt(password, Buffer.from(saltPart, 'base64url'), expected.length, {
      N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024
    }, (error, actual) => {
      resolve(!error && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
    });
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function maskEmail(value) {
  const [local, domain = ''] = String(value || '').split('@');
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 3);
  return `${shown}${'*'.repeat(Math.max(2, Math.min(8, local.length - shown.length)))}@${domain}`;
}

function extractClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

async function audit({ actor, action, target = '', ip = '', detail = '' }) {
  await pool.query(
    `INSERT INTO audit_logs(actor, action, target, ip_digest, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, target, ip ? digest(ip) : null, String(detail).slice(0, 500)]
  );
}

async function cleanExpired() {
  const mailRetentionDays = Math.max(1, Math.min(30, Number(process.env.MAIL_RETENTION_DAYS || 7)));
  const unmatchedRetentionDays = Math.max(1, Math.min(365, Number(process.env.UNMATCHED_RETENTION_DAYS || 14)));
  const auditRetentionDays = Math.max(7, Math.min(3650, Number(process.env.AUDIT_RETENTION_DAYS || 90)));
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  await pool.query('DELETE FROM login_challenges WHERE expires_at < NOW()');
  await pool.query('DELETE FROM alias_export_batches WHERE expires_at < NOW()');
  await pool.query(
    `UPDATE verification_messages
     SET code_encrypted = NULL, code_masked = NULL
     WHERE expires_at < NOW() AND code_encrypted IS NOT NULL`
  );
  await pool.query(
    `DELETE FROM verification_messages
     WHERE mail_expires_at < NOW()
       OR (mail_expires_at IS NULL AND received_at < NOW() - ($1::text || ' days')::interval)`,
    [String(mailRetentionDays)]
  );
  await pool.query('DELETE FROM mail_messages WHERE mail_expires_at < NOW()');
  await pool.query(
    "DELETE FROM unmatched_messages WHERE created_at < NOW() - ($1::text || ' days')::interval",
    [String(unmatchedRetentionDays)]
  );
  await pool.query(
    "DELETE FROM audit_logs WHERE created_at < NOW() - ($1::text || ' days')::interval",
    [String(auditRetentionDays)]
  );
}

async function updateRuntimeStatus(service, status, detail = '') {
  await pool.query(
    `INSERT INTO runtime_status(service, status, detail, heartbeat_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (service) DO UPDATE SET status = EXCLUDED.status,
       detail = EXCLUDED.detail, heartbeat_at = NOW(), updated_at = NOW()`,
    [service, status, String(detail).slice(0, 500)]
  );
}

module.exports = {
  pool,
  initDatabase,
  randomToken,
  digest,
  encrypt,
  decrypt,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  validEmail,
  maskEmail,
  extractClientIp,
  audit,
  cleanExpired,
  updateRuntimeStatus
};
