'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { pool, initDatabase, decrypt, encrypt, cleanExpired, updateRuntimeStatus } = require('./lib');
const { extractCode, findAlias, normalizeText } = require('./extract');

const pollSeconds = Math.max(5, Number(process.env.IMAP_POLL_SECONDS || 15));
const codeTtlMinutes = Math.max(1, Math.min(60, Number(process.env.CODE_TTL_MINUTES || 10)));
const maxMessageBytes = Math.max(64 * 1024, Number(process.env.MAX_MESSAGE_BYTES || 1024 * 1024));
const mailRetentionDays = Math.max(1, Math.min(30, Number(process.env.MAIL_RETENTION_DAYS || 7)));
const maxBodyChars = Math.max(1000, Math.min(500000, Number(process.env.MAX_BODY_CHARS || 200000)));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function senderText(parsed) {
  return parsed.from?.text || parsed.sender?.text || '';
}

function headerText(source) {
  const raw = source.toString('utf8');
  const splitAt = raw.search(/\r?\n\r?\n/);
  return (splitAt >= 0 ? raw.slice(0, splitAt) : raw).slice(0, 100000);
}

async function processMessage(account, message, aliases) {
  if (!message.source) return;
  const parsed = await simpleParser(message.source, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    maxHtmlLengthToParse: 200000
  });
  const headers = headerText(message.source);
  const alias = findAlias(headers, aliases);
  const messageKey = String(parsed.messageId || `uid:${message.uid}`);
  const receivedAt = parsed.date instanceof Date ? parsed.date : new Date();
  const sender = senderText(parsed).slice(0, 500);
  const subject = String(parsed.subject || '').slice(0, 500);
  const bodyText = String(parsed.text || normalizeText(parsed.html) || '').slice(0, maxBodyChars);

  if (!alias) {
    await pool.query(
      `INSERT INTO unmatched_messages(mail_account_id, message_key, sender, subject, recipient_headers, received_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mail_account_id, message_key) DO NOTHING`,
      [account.id, messageKey, sender, subject, headers.slice(0, 10000), receivedAt]
    );
    return;
  }

  const extracted = extractCode(subject, parsed.text, parsed.html);
  const expiresAt = new Date(receivedAt.getTime() + codeTtlMinutes * 60 * 1000);
  const mailExpiresAt = new Date(receivedAt.getTime() + mailRetentionDays * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO verification_messages(
       mail_account_id, alias_id, message_key, sender, subject, code_encrypted,
       code_masked, confidence, body_text_encrypted, received_at, expires_at, mail_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (mail_account_id, message_key) DO UPDATE SET
       alias_id = EXCLUDED.alias_id,
       sender = EXCLUDED.sender,
       subject = EXCLUDED.subject,
       code_encrypted = EXCLUDED.code_encrypted,
       code_masked = EXCLUDED.code_masked,
       confidence = EXCLUDED.confidence,
       body_text_encrypted = EXCLUDED.body_text_encrypted,
       received_at = EXCLUDED.received_at,
       expires_at = EXCLUDED.expires_at,
       mail_expires_at = EXCLUDED.mail_expires_at`,
    [
      account.id,
      alias.id,
      messageKey,
      sender,
      subject,
      extracted ? encrypt(extracted.code) : null,
      extracted ? `${'*'.repeat(Math.max(0, extracted.code.length - 2))}${extracted.code.slice(-2)}` : null,
      extracted?.confidence || 0,
      bodyText ? encrypt(bodyText) : null,
      receivedAt,
      expiresAt,
      mailExpiresAt
    ]
  );
}

async function syncAccount(account) {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.email, pass: decrypt(account.app_password_encrypted) },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = String(client.mailbox.uidValidity || '');
      if (account.uid_validity && account.uid_validity !== uidValidity) {
        account.last_uid = 0;
        await pool.query('UPDATE mail_accounts SET last_uid = 0, uid_validity = $1 WHERE id = $2', [uidValidity, account.id]);
      } else if (!account.uid_validity) {
        await pool.query('UPDATE mail_accounts SET uid_validity = $1 WHERE id = $2', [uidValidity, account.id]);
      }
      const aliasResult = await pool.query(
        'SELECT id, address FROM aliases WHERE mail_account_id = $1 AND enabled = TRUE',
        [account.id]
      );
      const uidNext = Number(client.mailbox.uidNext || 1);
      const firstUid = account.last_uid > 0
        ? Number(account.last_uid) + 1
        : uidNext;
      let highestUid = Number(account.last_uid || 0);
      if (firstUid < uidNext) {
        for await (const message of client.fetch(`${firstUid}:*`, {
          uid: true,
          source: { start: 0, maxLength: maxMessageBytes }
        }, { uid: true })) {
          await processMessage(account, message, aliasResult.rows);
          highestUid = Math.max(highestUid, Number(message.uid || 0));
        }
      }
      if (!account.body_sync_completed_at) {
        const since = new Date(Date.now() - mailRetentionDays * 24 * 60 * 60 * 1000);
        const recentUids = await client.search({ since }, { uid: true });
        if (recentUids.length) {
          for await (const message of client.fetch(recentUids, {
            uid: true,
            source: { start: 0, maxLength: maxMessageBytes }
          }, { uid: true })) {
            await processMessage(account, message, aliasResult.rows);
            highestUid = Math.max(highestUid, Number(message.uid || 0));
          }
        }
      }
      highestUid = Math.max(highestUid, uidNext - 1);
      if (highestUid > Number(account.last_uid || 0) || !account.body_sync_completed_at) {
        await pool.query(
          `UPDATE mail_accounts SET last_uid = $1,
           body_sync_completed_at = COALESCE(body_sync_completed_at, NOW()) WHERE id = $2`,
          [highestUid, account.id]
        );
      }
    } finally {
      lock.release();
    }
    await pool.query(
      `UPDATE mail_accounts SET status = 'connected', last_error = NULL,
       last_synced_at = NOW(), sync_requested_at = NULL, updated_at = NOW() WHERE id = $1`,
      [account.id]
    );
  } catch (error) {
    console.error(`IMAP sync failed for ${account.email}:`, error.message);
    await pool.query(
      `UPDATE mail_accounts SET status = 'error', last_error = $1,
       updated_at = NOW() WHERE id = $2`,
      [String(error.message || error).slice(0, 500), account.id]
    ).catch(console.error);
  } finally {
    if (client.usable) await client.logout().catch(() => {});
  }
}

async function cycle() {
  await updateRuntimeStatus('worker', 'running');
  const result = await pool.query(
    'SELECT * FROM mail_accounts WHERE enabled = TRUE ORDER BY sync_requested_at DESC NULLS LAST, id'
  );
  for (const account of result.rows) await syncAccount(account);
  await updateRuntimeStatus('worker', 'idle');
}

async function start() {
  await initDatabase();
  await updateRuntimeStatus('worker', 'starting');
  console.log(`Mail worker started; polling every ${pollSeconds} seconds`);
  let cleanupCounter = 0;
  while (true) {
    const startedAt = Date.now();
    await cycle().catch(console.error);
    cleanupCounter += 1;
    if (cleanupCounter >= Math.ceil(3600 / pollSeconds)) {
      await cleanExpired().catch(console.error);
      cleanupCounter = 0;
    }
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(1000, pollSeconds * 1000 - elapsed));
  }
}

start().catch((error) => {
  console.error(error);
  updateRuntimeStatus('worker', 'error', error.message).catch(console.error);
  process.exit(1);
});
