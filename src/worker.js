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
const globalConcurrency = Math.max(1, Math.min(10, Number(process.env.MAIL_WORKER_CONCURRENCY || 5)));
const providerConcurrency = Object.freeze({
  icloud: Math.max(1, Math.min(5, Number(process.env.ICLOUD_CONCURRENCY || 2))),
  gmail: Math.max(1, Math.min(5, Number(process.env.GMAIL_CONCURRENCY || 3))),
  outlook: Math.max(1, Math.min(5, Number(process.env.OUTLOOK_CONCURRENCY || 3)))
});
const retryMinutes = [1, 5, 15, 30];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function senderText(parsed) {
  return parsed.from?.text || parsed.sender?.text || '';
}

function recipientText(parsed) {
  return [parsed.to?.text, parsed.cc?.text].filter(Boolean).join(', ');
}

function headerText(source) {
  const raw = source.toString('utf8');
  const splitAt = raw.search(/\r?\n\r?\n/);
  return (splitAt >= 0 ? raw.slice(0, splitAt) : raw).slice(0, 100000);
}

function classifyError(error) {
  const value = String(error?.message || error || '未知错误');
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed/i.test(value)) {
    return { status: 'login_failed', reason: '邮箱登录失败，请检查邮箱地址和应用专用密码' };
  }
  if (/ETIMEDOUT|CONNECT_TIMEOUT|failed to establish connection in required time|timed out/i.test(value)) {
    return { status: 'timeout', reason: '连接邮箱服务器超时' };
  }
  return { status: 'failed', reason: value.slice(0, 500) };
}

async function runScheduled(items, handler) {
  const queue = [...items];
  const activeByProvider = new Map();
  const running = new Set();

  const startAvailable = () => {
    let started = false;
    for (let index = 0; index < queue.length && running.size < globalConcurrency;) {
      const item = queue[index];
      const provider = item.provider || 'icloud';
      const active = activeByProvider.get(provider) || 0;
      const limit = providerConcurrency[provider] || globalConcurrency;
      if (active >= limit) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      activeByProvider.set(provider, active + 1);
      const task = Promise.resolve(handler(item)).finally(() => {
        running.delete(task);
        activeByProvider.set(provider, Math.max(0, (activeByProvider.get(provider) || 1) - 1));
      });
      running.add(task);
      started = true;
    }
    return started;
  };

  while (queue.length || running.size) {
    startAvailable();
    if (running.size) await Promise.race(running);
  }
}

async function processMessage(account, message, aliases, uidValidity) {
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
  const recipients = recipientText(parsed).slice(0, 2000);
  const subject = String(parsed.subject || '').slice(0, 500);
  const bodyText = String(parsed.text || normalizeText(parsed.html) || '').slice(0, maxBodyChars);
  const extracted = extractCode(subject, parsed.text, parsed.html);
  const expiresAt = new Date(receivedAt.getTime() + codeTtlMinutes * 60 * 1000);
  const mailExpiresAt = new Date(receivedAt.getTime() + mailRetentionDays * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO mail_messages(
       mail_account_id, alias_id, uid, uid_validity, message_id, sender,
       recipients_encrypted, subject, body_preview, body_text_encrypted,
       code_encrypted, code_masked, confidence, code_expires_at, received_at, mail_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (mail_account_id, uid_validity, uid) DO UPDATE SET
       alias_id = EXCLUDED.alias_id, message_id = EXCLUDED.message_id,
       sender = EXCLUDED.sender, recipients_encrypted = EXCLUDED.recipients_encrypted,
       subject = EXCLUDED.subject, body_preview = EXCLUDED.body_preview,
       body_text_encrypted = EXCLUDED.body_text_encrypted,
       code_encrypted = EXCLUDED.code_encrypted, code_masked = EXCLUDED.code_masked,
       confidence = EXCLUDED.confidence, code_expires_at = EXCLUDED.code_expires_at,
       received_at = EXCLUDED.received_at,
       mail_expires_at = EXCLUDED.mail_expires_at, synced_at = NOW()`,
    [
      account.id, alias?.id || null, Number(message.uid), uidValidity, messageKey,
      sender, recipients ? encrypt(recipients) : null, subject, bodyText.slice(0, 320),
      bodyText ? encrypt(bodyText) : null, extracted ? encrypt(extracted.code) : null,
      extracted ? `${'*'.repeat(Math.max(0, extracted.code.length - 2))}${extracted.code.slice(-2)}` : null,
      extracted?.confidence || 0, extracted ? expiresAt : null, receivedAt, mailExpiresAt
    ]
  );

  if (!alias) {
    await pool.query(
      `INSERT INTO unmatched_messages(mail_account_id, message_key, sender, subject, recipient_headers, received_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mail_account_id, message_key) DO NOTHING`,
      [account.id, messageKey, sender, subject, headers.slice(0, 10000), receivedAt]
    );
    return;
  }

  await pool.query(
    `INSERT INTO verification_messages(
       mail_account_id, alias_id, message_key, sender, subject, code_encrypted,
       code_masked, confidence, body_text_encrypted, received_at, expires_at, mail_expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (mail_account_id, message_key) DO UPDATE SET
       alias_id = EXCLUDED.alias_id, sender = EXCLUDED.sender, subject = EXCLUDED.subject,
       code_encrypted = EXCLUDED.code_encrypted, code_masked = EXCLUDED.code_masked,
       confidence = EXCLUDED.confidence, body_text_encrypted = EXCLUDED.body_text_encrypted,
       received_at = EXCLUDED.received_at, expires_at = EXCLUDED.expires_at,
       mail_expires_at = EXCLUDED.mail_expires_at`,
    [
      account.id, alias.id, messageKey, sender, subject,
      extracted ? encrypt(extracted.code) : null,
      extracted ? `${'*'.repeat(Math.max(0, extracted.code.length - 2))}${extracted.code.slice(-2)}` : null,
      extracted?.confidence || 0, bodyText ? encrypt(bodyText) : null,
      receivedAt, expiresAt, mailExpiresAt
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
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000
  });
  await pool.query(
    `UPDATE mail_accounts SET sync_locked_at = NOW(), sync_status = 'connecting',
     status = 'connecting', updated_at = NOW() WHERE id = $1`,
    [account.id]
  );
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
      await pool.query("UPDATE mail_accounts SET sync_status = 'syncing', status = 'syncing' WHERE id = $1", [account.id]);
      const aliasResult = await pool.query(
        'SELECT id, address FROM aliases WHERE mail_account_id = $1 AND enabled = TRUE',
        [account.id]
      );
      const uidNext = Number(client.mailbox.uidNext || 1);
      const firstUid = account.last_uid > 0 ? Number(account.last_uid) + 1 : uidNext;
      let highestUid = Number(account.last_uid || 0);
      if (firstUid < uidNext) {
        for await (const message of client.fetch(`${firstUid}:*`, {
          uid: true,
          source: { start: 0, maxLength: maxMessageBytes }
        }, { uid: true })) {
          await processMessage(account, message, aliasResult.rows, uidValidity);
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
            await processMessage(account, message, aliasResult.rows, uidValidity);
            highestUid = Math.max(highestUid, Number(message.uid || 0));
          }
        }
      }
      highestUid = Math.max(highestUid, uidNext - 1);
      await pool.query(
        `UPDATE mail_accounts SET last_uid = $1,
         body_sync_completed_at = COALESCE(body_sync_completed_at, NOW()),
         first_sync_completed = TRUE WHERE id = $2`,
        [highestUid, account.id]
      );
    } finally {
      lock.release();
    }
    await pool.query(
      `UPDATE mail_accounts SET status = 'connected', verification_status = 'verified',
       sync_status = 'completed', failure_count = 0, last_error = NULL,
       last_synced_at = NOW(), next_retry_at = NULL, sync_requested_at = NULL,
       sync_locked_at = NULL, updated_at = NOW() WHERE id = $1`,
      [account.id]
    );
  } catch (error) {
    const classified = classifyError(error);
    await pool.query(
      `UPDATE mail_accounts SET status = 'error', verification_status = $1,
       sync_status = $1, failure_count = failure_count + 1, last_error = $2,
       next_retry_at = NOW() + INTERVAL '5 minutes', sync_locked_at = NULL,
       updated_at = NOW() WHERE id = $3`,
      [classified.status, classified.reason, account.id]
    ).catch(console.error);
    throw error;
  } finally {
    if (client.usable) await client.logout().catch(() => {});
  }
}

async function refreshImportJob(jobId) {
  await pool.query(
    `UPDATE mail_import_jobs j SET
       waiting_count = s.waiting_count,
       validating_count = s.validating_count,
       syncing_count = s.syncing_count,
       success_count = s.success_count,
       failed_count = s.failed_count,
       status = CASE
         WHEN s.active_count > 0 THEN 'processing'
         WHEN s.failed_count > 0 AND s.success_count > 0 THEN 'partial'
         WHEN s.failed_count > 0 THEN 'failed'
         ELSE 'completed'
       END,
       completed_at = CASE WHEN s.active_count = 0 THEN COALESCE(j.completed_at, NOW()) ELSE NULL END
     FROM (
       SELECT job_id,
         COUNT(*) FILTER (WHERE status IN ('waiting', 'retry_wait'))::int AS waiting_count,
         COUNT(*) FILTER (WHERE status = 'validating')::int AS validating_count,
         COUNT(*) FILTER (WHERE status = 'syncing')::int AS syncing_count,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS success_count,
         COUNT(*) FILTER (WHERE status IN ('format_error', 'duplicate', 'login_failed', 'timeout', 'failed'))::int AS failed_count,
         COUNT(*) FILTER (WHERE status IN ('waiting', 'retry_wait', 'validating', 'syncing'))::int AS active_count
       FROM mail_import_items WHERE job_id = $1 GROUP BY job_id
     ) s WHERE j.id = s.job_id`,
    [jobId]
  );
}

async function processImportItem(item) {
  const config = {
    icloud: { host: 'imap.mail.me.com', port: 993, secure: true },
    gmail: { host: 'imap.gmail.com', port: 993, secure: true },
    outlook: { host: 'outlook.office365.com', port: 993, secure: true }
  }[item.provider];
  let createdAccountId = null;
  try {
    const accountResult = await pool.query(
      `INSERT INTO mail_accounts(
         email, provider, app_password_encrypted, host, port, secure,
         status, verification_status, sync_status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'validating', 'pending')
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [item.email, item.provider, item.app_password_encrypted, config.host, config.port, config.secure]
    );
    if (!accountResult.rowCount) {
      const duplicate = await pool.query('SELECT id FROM mail_accounts WHERE email = $1', [item.email]);
      await pool.query(
        `UPDATE mail_import_items SET status = 'duplicate', failure_reason = '邮箱已存在',
         mail_account_id = $1, app_password_encrypted = NULL,
         next_retry_at = NULL, completed_at = NOW() WHERE id = $2`,
        [duplicate.rows[0]?.id || null, item.id]
      );
      return;
    }
    const account = accountResult.rows[0];
    createdAccountId = account.id;
    await pool.query(
      `UPDATE mail_import_items SET status = 'syncing', mail_account_id = $1,
       failure_reason = NULL WHERE id = $2`,
      [account.id, item.id]
    );
    await refreshImportJob(item.job_id);
    await syncAccount(account);
    await pool.query(
      `UPDATE mail_import_items SET status = 'completed', failure_reason = NULL,
       app_password_encrypted = NULL, next_retry_at = NULL, completed_at = NOW() WHERE id = $1`,
      [item.id]
    );
  } catch (error) {
    const classified = classifyError(error);
    const retryIndex = Math.min(item.attempt_count - 1, retryMinutes.length - 1);
    const shouldRetry = item.attempt_count <= retryMinutes.length;
    if (createdAccountId) {
      await pool.query('DELETE FROM mail_accounts WHERE id = $1 AND first_sync_completed = FALSE', [createdAccountId]).catch(() => {});
    }
    await pool.query(
      `UPDATE mail_import_items SET status = $1, failure_reason = $2,
       mail_account_id = NULL,
       next_retry_at = CASE WHEN $3::boolean THEN NOW() + ($4::text || ' minutes')::interval ELSE NULL END,
       completed_at = CASE WHEN $3::boolean THEN NULL ELSE NOW() END WHERE id = $5`,
      [shouldRetry ? 'retry_wait' : classified.status, classified.reason, shouldRetry, String(retryMinutes[retryIndex]), item.id]
    );
  } finally {
    await refreshImportJob(item.job_id);
  }
}

async function processImportQueue() {
  const claimed = await pool.query(
    `UPDATE mail_import_items SET status = 'validating', attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM mail_import_items
       WHERE status IN ('waiting', 'retry_wait')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED
     ) RETURNING *`
  );
  if (!claimed.rowCount) return;
  const jobIds = [...new Set(claimed.rows.map((row) => row.job_id))];
  await Promise.all(jobIds.map(refreshImportJob));
  await runScheduled(claimed.rows, processImportItem);
}

async function processAccountQueue() {
  const result = await pool.query(
    `SELECT * FROM mail_accounts
     WHERE enabled = TRUE
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       AND (sync_locked_at IS NULL OR sync_locked_at < NOW() - INTERVAL '10 minutes')
       AND (sync_requested_at IS NOT NULL OR last_synced_at IS NULL
         OR last_synced_at < NOW() - ($1::text || ' seconds')::interval)
     ORDER BY sync_requested_at DESC NULLS LAST, last_synced_at NULLS FIRST, id
     LIMIT 50`,
    [String(pollSeconds)]
  );
  await runScheduled(result.rows, async (account) => {
    try {
      await syncAccount(account);
    } catch (error) {
      console.error(`IMAP sync failed for ${account.email}:`, error.message);
    }
  });
}

async function cycle() {
  await updateRuntimeStatus('worker', 'running');
  await processImportQueue();
  await processAccountQueue();
  await updateRuntimeStatus('worker', 'idle');
}

async function start() {
  await initDatabase();
  await updateRuntimeStatus('worker', 'starting');
  console.log(`Mail worker started; polling every ${pollSeconds} seconds with concurrency ${globalConcurrency}`);
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
