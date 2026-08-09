'use strict';

const mailForm = document.querySelector('#mail-query-form');
const mailTokenInput = document.querySelector('#mail-token');
const mailErrorBox = document.querySelector('#mail-query-error');
const mailResultBox = document.querySelector('#mail-result');
const mailBatchForm = document.querySelector('#mail-batch-form');
const mailBatchTokensInput = document.querySelector('#mail-batch-tokens');
const mailBatchCount = document.querySelector('#mail-batch-count');
const mailBatchErrorBox = document.querySelector('#mail-batch-error');
const mailBatchResultBox = document.querySelector('#mail-batch-result');
const totpForm = document.querySelector('#totp-query-form');
const totpSecretInput = document.querySelector('#totp-secret');
const totpQrFileInput = document.querySelector('#totp-qr-file');
const totpQrUploadButton = document.querySelector('#totp-qr-upload');
const totpErrorBox = document.querySelector('#totp-query-error');
const totpResultBox = document.querySelector('#totp-result');
const toast = document.querySelector('#toast');
const activeTotps = new Map();
let mailBatchRefreshTimer;
let activeMailBatchTokens = [];
let mailBatchRefreshInFlight = false;
let activeMailToken = '';
let activeMailPage = 1;
let totpCountdownTimer;
let totpRefreshInFlight = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 1800);
}

async function copyCode(code, message) {
  await navigator.clipboard.writeText(code);
  showToast(message);
}

async function request(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

function renderAliasMeta(data) {
  return `<div class="result-meta"><strong>${escapeHtml(data.label || '子邮箱')}</strong><span>${escapeHtml(data.alias)} · ${data.pagination.total} 封邮件</span></div>`;
}

function formatMailDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

function mailCodeMarkup(message) {
  if (!message.code) return '<span class="mail-code-state">无验证码</span>';
  return `<span class="mail-code"><span>${escapeHtml(message.code)}</span><button class="btn btn-secondary btn-icon" type="button" data-copy-mail-code="${message.id}" title="复制验证码" aria-label="复制验证码"><i data-lucide="copy" class="icon"></i></button></span>`;
}

function renderMail(data) {
  mailResultBox.classList.remove('hidden');
  mailResultBox.innerHTML = `${renderAliasMeta(data)}${data.messages.length ? `
    <div class="mail-list">${data.messages.map((message) => `
      <article class="mail-item" data-mail-id="${message.id}">
        <header class="mail-item-head">
          <div class="mail-item-title"><strong>${escapeHtml(message.subject || '无主题')}</strong><span>${escapeHtml(message.sender || '未知发件人')}</span></div>
          <time datetime="${escapeHtml(message.receivedAt)}">${escapeHtml(formatMailDate(message.receivedAt))}</time>
        </header>
        <p class="mail-preview">${escapeHtml(message.bodyPreview || '这封历史邮件没有可显示的正文。')}</p>
        <footer class="mail-item-foot">${mailCodeMarkup(message)}<button class="btn btn-secondary" type="button" data-open-mail="${message.id}"><i data-lucide="mail-open" class="icon"></i><span>查看正文</span></button></footer>
        <div class="mail-body-panel hidden" data-mail-body="${message.id}"></div>
      </article>`).join('')}</div>
    <div class="mail-pagination">
      <button class="btn btn-secondary" type="button" data-mail-page="${data.pagination.page - 1}" ${data.pagination.page <= 1 ? 'disabled' : ''}><i data-lucide="chevron-left" class="icon"></i><span>上一页</span></button>
      <span>第 ${data.pagination.page} 页 · 共 ${data.pagination.total} 封</span>
      <button class="btn btn-secondary" type="button" data-mail-page="${data.pagination.page + 1}" ${data.pagination.hasMore ? '' : 'disabled'}><span>下一页</span><i data-lucide="chevron-right" class="icon"></i></button>
    </div>` : '<p class="muted result-empty">该子邮箱最近 7 天内没有已归属邮件。</p>'}`;
  lucide.createIcons();
  mailResultBox.querySelectorAll('[data-copy-mail-code]').forEach((button) => button.addEventListener('click', () => {
    const message = data.messages.find((item) => String(item.id) === button.dataset.copyMailCode);
    if (message?.code) copyCode(message.code, '邮箱验证码已复制');
  }));
  mailResultBox.querySelectorAll('[data-open-mail]').forEach((button) => button.addEventListener('click', () => openMailMessage(button)));
  mailResultBox.querySelectorAll('[data-mail-page]').forEach((button) => button.addEventListener('click', () => queryMailPage(Number(button.dataset.mailPage))));
}

async function openMailMessage(button) {
  const messageId = Number(button.dataset.openMail);
  const panel = mailResultBox.querySelector(`[data-mail-body="${messageId}"]`);
  if (!panel) return;
  if (panel.dataset.loaded === 'true') {
    panel.classList.toggle('hidden');
    return;
  }
  button.disabled = true;
  try {
    const data = await request('/api/query/message', { token: activeMailToken, messageId });
    const body = document.createElement('pre');
    body.className = 'mail-body';
    body.textContent = data.message.body || '这封邮件没有可显示的纯文本正文。';
    panel.replaceChildren(body);
    panel.dataset.loaded = 'true';
    panel.classList.remove('hidden');
  } catch (error) {
    panel.textContent = error.message;
    panel.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
}

async function queryMailPage(page) {
  if (!activeMailToken || page < 1) return;
  activeMailPage = page;
  mailErrorBox.textContent = '';
  try {
    renderMail(await request('/api/query', { token: activeMailToken, page: activeMailPage, pageSize: 20 }));
  } catch (error) {
    mailErrorBox.textContent = error.message;
  }
}

function parseBatchTokens() {
  return mailBatchTokensInput.value
    .split(/\r?\n/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function mailBatchStatus(item) {
  if (item.status === 'received') return '<span class="batch-status received"><span></span>已收到</span>';
  if (item.status === 'waiting') return '<span class="batch-status waiting"><span></span>等待中</span>';
  return '<span class="batch-status invalid"><span></span>密钥无效</span>';
}

function renderMailBatch(data) {
  const received = data.results.filter((item) => item.status === 'received').length;
  const waiting = data.results.filter((item) => item.status === 'waiting').length;
  const invalid = data.results.filter((item) => item.status === 'invalid').length;
  mailBatchResultBox.classList.remove('hidden');
  mailBatchResultBox.innerHTML = `
    <div class="result-meta batch-result-meta"><strong>批量接码列表</strong><span>已收到 ${received} · 等待 ${waiting} · 无效 ${invalid}</span></div>
    <div class="batch-result-list">${data.results.map((item) => `
      <section class="batch-result-row batch-${item.status}">
        <div class="batch-result-identity">
          <span class="batch-row-index">${item.index + 1}</span>
          <div><strong>${escapeHtml(item.label || item.alias || '未识别密钥')}</strong><small>${escapeHtml(item.alias || `第 ${item.index + 1} 个查询密钥`)}</small></div>
        </div>
        <div class="batch-result-state">${mailBatchStatus(item)}</div>
        <div class="batch-result-code">${item.message ? `<strong>${escapeHtml(item.message.code)}</strong><small>${escapeHtml(item.message.sender || item.message.subject || '验证码邮件')}</small>` : `<strong>------</strong><small>${item.status === 'invalid' ? '请检查查询密钥' : '等待最新有效验证码'}</small>`}</div>
        <div class="batch-result-action">${item.message ? `<button class="btn btn-secondary btn-icon" type="button" data-copy-batch-code="${item.index}" title="复制验证码" aria-label="复制验证码"><i data-lucide="copy" class="icon"></i></button>` : ''}</div>
      </section>`).join('')}</div>
    <div class="batch-refresh-note"><i data-lucide="refresh-cw" class="icon"></i><span>页面保持打开时自动刷新等待中的验证码</span><button id="refresh-mail-batch" class="btn btn-secondary" type="button"><i data-lucide="refresh-cw" class="icon"></i><span>立即刷新</span></button></div>`;
  mailBatchResultBox.querySelectorAll('[data-copy-batch-code]').forEach((button) => button.addEventListener('click', () => {
    const item = data.results[Number(button.dataset.copyBatchCode)];
    if (item?.message) copyCode(item.message.code, '邮箱验证码已复制');
  }));
  document.querySelector('#refresh-mail-batch').addEventListener('click', () => refreshMailBatch());
  lucide.createIcons();
  clearTimeout(mailBatchRefreshTimer);
  if (waiting) mailBatchRefreshTimer = setTimeout(() => refreshMailBatch(), Number(data.refreshAfterSeconds || 15) * 1000);
}

async function queryMailBatch(tokens) {
  return request('/api/query/batch', { tokens });
}

async function refreshMailBatch() {
  if (mailBatchRefreshInFlight || !activeMailBatchTokens.length) return;
  mailBatchRefreshInFlight = true;
  mailBatchErrorBox.textContent = '';
  const refreshButton = document.querySelector('#refresh-mail-batch');
  if (refreshButton) refreshButton.disabled = true;
  try {
    renderMailBatch(await queryMailBatch(activeMailBatchTokens));
  } catch (error) {
    clearTimeout(mailBatchRefreshTimer);
    mailBatchErrorBox.textContent = error.message;
  } finally {
    mailBatchRefreshInFlight = false;
    if (refreshButton?.isConnected) refreshButton.disabled = false;
  }
}

function totpTitle(item) {
  const names = [item.data.issuer, item.data.accountName].filter(Boolean);
  return names.length ? names.join(' · ') : `2FA 密钥末四位 ${item.data.secretHint}`;
}

function totpPlatform(issuer) {
  const value = String(issuer || '').trim();
  const normalized = value.toLowerCase();
  if (/google|gmail/.test(normalized)) return { tone: 'google', mark: 'G' };
  if (/microsoft|outlook|office|azure/.test(normalized)) return { tone: 'microsoft', mark: 'M' };
  if (/github/.test(normalized)) return { tone: 'github', mark: 'GH' };
  if (/apple|icloud/.test(normalized)) return { tone: 'apple', mark: 'A' };
  if (/discord/.test(normalized)) return { tone: 'discord', mark: 'D' };
  if (/telegram/.test(normalized)) return { tone: 'telegram', mark: 'T' };
  return { tone: 'default', mark: value ? value.slice(0, 1).toUpperCase() : '2F' };
}

function renderTotpAvatar(issuer) {
  const platform = totpPlatform(issuer);
  return `<span class="totp-platform-avatar tone-${platform.tone}" aria-hidden="true">${escapeHtml(platform.mark)}</span>`;
}

function renderTotps() {
  const entries = [...activeTotps.values()];
  totpResultBox.classList.toggle('hidden', !entries.length);
  if (!entries.length) {
    clearInterval(totpCountdownTimer);
    return;
  }
  totpResultBox.innerHTML = `<div class="result-meta totp-result-meta"><strong>当前会话中的 2FA</strong><span>${entries.length} 条独立密钥</span></div><div class="totp-entry-list">${entries.map((item) => `
    <section class="totp-entry" data-totp-entry="${item.data.id}">
      <div class="totp-entry-head"><div class="totp-identity">${renderTotpAvatar(item.data.issuer)}<div><h2>${escapeHtml(item.data.issuer || '未命名平台')}</h2><p>${escapeHtml(item.data.accountName || `密钥末四位 ${item.data.secretHint}`)}</p></div></div><button class="btn btn-danger btn-icon" type="button" data-remove-totp="${item.data.id}" title="从当前页面移除" aria-label="从当前页面移除"><i data-lucide="x" class="icon"></i></button></div>
      <div class="totp-code-line"><span class="code-value totp-code-value">${escapeHtml(item.data.code)}</span><button class="btn btn-secondary btn-icon" type="button" data-copy-totp="${item.data.id}" title="复制 2FA 验证码" aria-label="复制 2FA 验证码"><i data-lucide="copy" class="icon"></i></button></div>
      <div class="totp-entry-foot"><span class="totp-live-dot"></span><span data-totp-remaining="${item.data.id}">${item.data.remaining} 秒后自动刷新</span><span class="totp-secret-hint">末四位 ${escapeHtml(item.data.secretHint)}</span></div>
    </section>`).join('')}</div>`;
  document.querySelectorAll('[data-copy-totp]').forEach((button) => button.addEventListener('click', () => {
    copyCode(activeTotps.get(button.dataset.copyTotp).data.code, '2FA 验证码已复制');
  }));
  document.querySelectorAll('[data-remove-totp]').forEach((button) => button.addEventListener('click', () => {
    activeTotps.delete(button.dataset.removeTotp);
    renderTotps();
  }));
  lucide.createIcons();
  startTotpCountdown();
}

function startTotpCountdown() {
  clearInterval(totpCountdownTimer);
  const update = () => {
    let shouldRefresh = false;
    for (const item of activeTotps.values()) {
      const elapsed = Math.floor((Date.now() - item.receivedAt) / 1000);
      const remaining = Math.max(0, item.data.remaining - elapsed);
      const label = document.querySelector(`[data-totp-remaining="${item.data.id}"]`);
      if (label) label.textContent = remaining ? `${remaining} 秒后自动刷新` : '正在生成最新动态码';
      if (!remaining) shouldRefresh = true;
    }
    if (shouldRefresh) refreshTotps();
  };
  update();
  totpCountdownTimer = setInterval(update, 1000);
}

async function convertTotps(entries) {
  return request('/api/query/totp', { entries });
}

async function detectQrCode(file) {
  if (!('BarcodeDetector' in window)) throw new Error('当前浏览器不支持本地二维码识别，请直接粘贴原始密钥或 otpauth 地址');
  const supported = await BarcodeDetector.getSupportedFormats();
  if (!supported.includes('qr_code')) throw new Error('当前浏览器未启用二维码识别，请直接粘贴原始密钥');
  const bitmap = await createImageBitmap(file);
  try {
    const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
    const value = codes[0]?.rawValue || '';
    if (!value.toLowerCase().startsWith('otpauth://totp/')) throw new Error('图片中没有识别到标准 TOTP 二维码');
    return value;
  } finally {
    bitmap.close();
  }
}

async function refreshTotps() {
  if (totpRefreshInFlight || !activeTotps.size) return;
  totpRefreshInFlight = true;
  try {
    const current = [...activeTotps.values()];
    const response = await convertTotps(current.map((item) => ({ secret: item.secret })));
    for (const data of response.totps) {
      const existing = current.find((item) => item.data.id === data.id);
      if (existing) activeTotps.set(String(data.id), { secret: existing.secret, data, receivedAt: Date.now() });
    }
    renderTotps();
  } catch (error) {
    clearInterval(totpCountdownTimer);
    totpErrorBox.textContent = error.message;
  } finally {
    totpRefreshInFlight = false;
  }
}

document.querySelectorAll('[data-query-tab]').forEach((button) => button.addEventListener('click', () => {
  const selected = button.dataset.queryTab;
  document.querySelectorAll('[data-query-tab]').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.query-panel').forEach((panel) => {
    const active = panel.id === `${selected}-panel`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}));

document.querySelectorAll('[data-mail-mode]').forEach((button) => button.addEventListener('click', () => {
  const batchMode = button.dataset.mailMode === 'batch';
  document.querySelectorAll('[data-mail-mode]').forEach((modeButton) => {
    const active = modeButton === button;
    modeButton.classList.toggle('active', active);
    modeButton.setAttribute('aria-pressed', String(active));
  });
  mailForm.classList.toggle('hidden', batchMode);
  mailBatchForm.classList.toggle('hidden', !batchMode);
  mailResultBox.classList.toggle('hidden', batchMode || !mailResultBox.innerHTML);
  mailBatchResultBox.classList.toggle('hidden', !batchMode || !mailBatchResultBox.innerHTML);
  if (!batchMode) clearTimeout(mailBatchRefreshTimer);
  else if (activeMailBatchTokens.length && mailBatchResultBox.innerHTML) mailBatchRefreshTimer = setTimeout(() => refreshMailBatch(), 15000);
}));

mailBatchTokensInput.addEventListener('input', () => {
  const count = parseBatchTokens().length;
  mailBatchCount.textContent = String(count);
  mailBatchCount.parentElement.classList.toggle('danger-text', count > 50);
});

totpQrUploadButton.addEventListener('click', () => totpQrFileInput.click());
totpQrFileInput.addEventListener('change', async () => {
  const file = totpQrFileInput.files[0];
  if (!file) return;
  totpErrorBox.textContent = '';
  totpQrUploadButton.disabled = true;
  try {
    totpSecretInput.value = await detectQrCode(file);
    showToast('二维码已识别，请确认后转换');
    totpSecretInput.focus();
  } catch (error) {
    totpErrorBox.textContent = error.message;
  } finally {
    totpQrUploadButton.disabled = false;
    totpQrFileInput.value = '';
  }
});

mailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailErrorBox.textContent = '';
  mailResultBox.classList.add('hidden');
  const button = mailForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    activeMailToken = mailTokenInput.value.trim();
    activeMailPage = 1;
    renderMail(await request('/api/query', { token: activeMailToken, page: activeMailPage, pageSize: 20 }));
  } catch (error) {
    activeMailToken = '';
    mailErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

mailBatchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailBatchErrorBox.textContent = '';
  const tokens = parseBatchTokens();
  if (!tokens.length) {
    mailBatchErrorBox.textContent = '请至少输入一个查询密钥';
    return;
  }
  if (tokens.length > 50) {
    mailBatchErrorBox.textContent = '每次最多查询 50 个密钥';
    return;
  }
  const button = mailBatchForm.querySelector('[type="submit"]');
  button.disabled = true;
  clearTimeout(mailBatchRefreshTimer);
  activeMailBatchTokens = tokens;
  try {
    renderMailBatch(await queryMailBatch(tokens));
  } catch (error) {
    activeMailBatchTokens = [];
    mailBatchErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

totpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  totpErrorBox.textContent = '';
  const button = totpForm.querySelector('[type="submit"]');
  const secret = totpSecretInput.value.trim();
  button.disabled = true;
  try {
    const response = await convertTotps([{ secret, issuer: document.querySelector('#totp-issuer').value, accountName: document.querySelector('#totp-account-name').value }]);
    const data = response.totps[0];
    activeTotps.set(String(data.id), { secret, data, receivedAt: Date.now() });
    totpForm.reset();
    renderTotps();
    showToast('2FA 已转换并同步到管理后台');
  } catch (error) {
    totpErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

lucide.createIcons();
