'use strict';

const accessView = document.querySelector('#access-view');
const inboxWorkspace = document.querySelector('#inbox-workspace');
const mailForm = document.querySelector('#mail-query-form');
const mailTokenInput = document.querySelector('#mail-token');
const mailErrorBox = document.querySelector('#mail-query-error');
const mailListPane = document.querySelector('#mail-list-pane');
const mailListTitle = document.querySelector('#mail-list-title');
const mailSearchInput = document.querySelector('#mail-search');
const clearMailSearchButton = document.querySelector('#clear-mail-search');
const mailListStatus = document.querySelector('#mail-list-status');
const mailMessageList = document.querySelector('#mail-message-list');
const mailListEmpty = document.querySelector('#mail-list-empty');
const mailLoadMoreButton = document.querySelector('#mail-load-more');
const mailLoadSentinel = document.querySelector('#mail-load-sentinel');
const mailDetail = document.querySelector('#mail-detail');
const refreshMailButton = document.querySelector('#refresh-mail');
const changeKeyButton = document.querySelector('#change-key');
const batchView = document.querySelector('#batch-view');
const mailBatchForm = document.querySelector('#mail-batch-form');
const mailBatchTokensInput = document.querySelector('#mail-batch-tokens');
const mailBatchCount = document.querySelector('#mail-batch-count');
const mailBatchErrorBox = document.querySelector('#mail-batch-error');
const mailBatchResultBox = document.querySelector('#mail-batch-result');
const totpView = document.querySelector('#totp-view');
const totpForm = document.querySelector('#totp-query-form');
const totpSecretInput = document.querySelector('#totp-secret');
const totpQrFileInput = document.querySelector('#totp-qr-file');
const totpQrUploadButton = document.querySelector('#totp-qr-upload');
const totpErrorBox = document.querySelector('#totp-query-error');
const totpResultBox = document.querySelector('#totp-result');
const toast = document.querySelector('#toast');

const activeTotps = new Map();
const mailState = {
  token: '',
  filter: 'all',
  keyword: '',
  cursor: null,
  loading: false,
  selectedId: null,
  requestId: 0
};
let mailSearchTimer;
let mailBatchRefreshTimer;
let activeMailBatchTokens = [];
let mailBatchRefreshInFlight = false;
let totpCountdownTimer;
let totpRefreshInFlight = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function renderIcons() {
  if (globalThis.lucide?.createIcons) globalThis.lucide.createIcons();
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

function formatMailDate(value, detailed = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (!detailed && sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleString('zh-CN', detailed
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit' });
}

function setPublicView(view) {
  mailListPane.classList.toggle('hidden', view !== 'mail');
  mailDetail.classList.toggle('hidden', view !== 'mail');
  batchView.classList.toggle('hidden', view !== 'batch');
  totpView.classList.toggle('hidden', view !== 'totp');
  inboxWorkspace.dataset.view = view;
  document.querySelectorAll('[data-public-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.publicView === view && (view !== 'mail' || button.dataset.mailFilter === mailState.filter));
  });
  if (view !== 'batch') clearTimeout(mailBatchRefreshTimer);
  if (view === 'batch' && activeMailBatchTokens.length && mailBatchResultBox.innerHTML) {
    mailBatchRefreshTimer = setTimeout(() => refreshMailBatch(), 15000);
  }
}

function resetMailDetail() {
  mailState.selectedId = null;
  mailDetail.classList.remove('mobile-visible');
  mailDetail.innerHTML = '<div class="public-detail-empty"><i data-lucide="mail-open"></i><strong>选择一封邮件</strong><span>正文将在点击后按需、安全地加载。</span></div>';
  renderIcons();
}

function renderMessageItem(message) {
  const hasCode = Boolean(message.hasCode || message.codeMasked);
  return `<button class="public-message-item" type="button" data-message-id="${message.id}">
    <span class="public-message-row"><strong>${escapeHtml(message.sender || '未知发件人')}</strong><time datetime="${escapeHtml(message.receivedAt)}">${escapeHtml(formatMailDate(message.receivedAt))}</time></span>
    <span class="public-message-subject">${escapeHtml(message.subject || '无主题')}</span>
    <span class="public-message-preview">${escapeHtml(message.bodyPreview || '这封邮件没有可显示的摘要。')}</span>
    <span class="public-message-foot">${hasCode ? '<span class="public-code-badge"><i data-lucide="badge-check"></i>验证码</span>' : '<span>普通邮件</span>'}<i data-lucide="chevron-right"></i></span>
  </button>`;
}

function bindMessageItems(messages) {
  for (const message of messages) {
    const button = mailMessageList.querySelector(`[data-message-id="${message.id}"]`);
    if (button) button.addEventListener('click', () => openMailMessage(message, button));
  }
}

function updateMailListState(loadedCount) {
  mailListEmpty.classList.toggle('hidden', mailMessageList.children.length > 0 || mailState.loading);
  mailLoadMoreButton.classList.toggle('hidden', !mailState.cursor || mailState.loading);
  if (mailState.loading) mailListStatus.textContent = mailMessageList.children.length ? '正在加载更多邮件...' : '正在加载邮件...';
  else if (mailMessageList.children.length) mailListStatus.textContent = loadedCount ? `已加载 ${mailMessageList.children.length} 封邮件` : '';
  else mailListStatus.textContent = '';
}

async function loadMessages({ reset = false, unlock = false } = {}) {
  if (!mailState.token || mailState.loading) return false;
  if (!reset && !mailState.cursor) return false;
  mailState.loading = true;
  const requestId = ++mailState.requestId;
  if (reset) {
    mailState.cursor = null;
    mailMessageList.replaceChildren();
    resetMailDetail();
  }
  refreshMailButton.disabled = true;
  updateMailListState(0);
  try {
    const data = await request('/api/query', {
      token: mailState.token,
      cursor: reset ? null : mailState.cursor,
      limit: 40,
      keyword: mailState.keyword,
      status: mailState.filter === 'code' ? 'code' : ''
    });
    if (requestId !== mailState.requestId) return false;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    mailMessageList.insertAdjacentHTML('beforeend', messages.map(renderMessageItem).join(''));
    bindMessageItems(messages);
    mailState.cursor = data.nextCursor || null;
    if (unlock) {
      accessView.classList.add('hidden');
      inboxWorkspace.classList.remove('hidden');
      setPublicView('mail');
    }
    renderIcons();
    return true;
  } catch (error) {
    if (unlock) mailState.token = '';
    throw error;
  } finally {
    if (requestId === mailState.requestId) {
      mailState.loading = false;
      refreshMailButton.disabled = false;
      updateMailListState(mailMessageList.children.length);
    }
  }
}

async function openMailMessage(message, button) {
  mailState.selectedId = Number(message.id);
  mailMessageList.querySelectorAll('.public-message-item').forEach((item) => item.classList.toggle('active', item === button));
  mailDetail.classList.add('mobile-visible');
  mailDetail.innerHTML = '<div class="public-detail-loading"><span class="public-spinner"></span><span>正在加载邮件正文...</span></div>';
  try {
    const data = await request('/api/query/message', { token: mailState.token, messageId: Number(message.id) });
    if (mailState.selectedId !== Number(message.id)) return;
    const detail = data.message;
    mailDetail.innerHTML = `<header class="public-detail-head">
      <button class="public-mobile-back" type="button" title="返回邮件列表" aria-label="返回邮件列表"><i data-lucide="arrow-left"></i></button>
      <div><span class="pane-kicker">MESSAGE</span><h1>${escapeHtml(detail.subject || '无主题')}</h1></div>
      ${detail.code ? `<button class="btn btn-secondary" type="button" data-copy-detail-code><i data-lucide="copy" class="icon"></i><span>复制验证码</span></button>` : ''}
    </header>
    <dl class="public-detail-meta">
      <div><dt>发件人</dt><dd>${escapeHtml(detail.sender || '未知发件人')}</dd></div>
      <div><dt>收到时间</dt><dd>${escapeHtml(formatMailDate(detail.receivedAt, true))}</dd></div>
      <div><dt>验证码</dt><dd>${detail.code ? `<strong class="public-detail-code">${escapeHtml(detail.code)}</strong>` : '未提取到验证码'}</dd></div>
    </dl>
    <pre class="public-detail-body"></pre>`;
    mailDetail.querySelector('.public-detail-body').textContent = detail.body || '这封邮件没有可显示的纯文本正文。';
    mailDetail.querySelector('.public-mobile-back').addEventListener('click', () => mailDetail.classList.remove('mobile-visible'));
    const copyButton = mailDetail.querySelector('[data-copy-detail-code]');
    if (copyButton) copyButton.addEventListener('click', () => copyCode(detail.code, '验证码已复制'));
    renderIcons();
  } catch (error) {
    mailDetail.innerHTML = `<div class="public-detail-empty"><i data-lucide="circle-alert"></i><strong>正文加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    renderIcons();
  }
}

function parseBatchTokens() {
  return mailBatchTokensInput.value.split(/\r?\n/).map((token) => token.trim()).filter(Boolean);
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
  mailBatchResultBox.innerHTML = `<div class="result-meta batch-result-meta"><strong>查询结果</strong><span>已收到 ${received} · 等待 ${waiting} · 无效 ${invalid}</span></div>
    <div class="batch-result-list">${data.results.map((item) => `<section class="batch-result-row batch-${item.status}">
      <div class="batch-result-identity"><span class="batch-row-index">${item.index + 1}</span><div><strong>查询项 ${item.index + 1}</strong><small>独立查询密钥</small></div></div>
      <div class="batch-result-state">${mailBatchStatus(item)}</div>
      <div class="batch-result-code">${item.message ? `<strong>${escapeHtml(item.message.code)}</strong><small>${escapeHtml(item.message.sender || item.message.subject || '验证码邮件')}</small>` : `<strong>------</strong><small>${item.status === 'invalid' ? '请检查查询密钥' : '等待最新验证码'}</small>`}</div>
      <div class="batch-result-action">${item.message ? `<button class="btn btn-secondary btn-icon" type="button" data-copy-batch-code="${item.index}" title="复制验证码" aria-label="复制验证码"><i data-lucide="copy" class="icon"></i></button>` : ''}</div>
    </section>`).join('')}</div>
    <div class="batch-refresh-note"><i data-lucide="refresh-cw" class="icon"></i><span>页面保持打开时自动刷新等待中的结果</span><button id="refresh-mail-batch" class="btn btn-secondary" type="button"><i data-lucide="refresh-cw" class="icon"></i><span>立即刷新</span></button></div>`;
  mailBatchResultBox.querySelectorAll('[data-copy-batch-code]').forEach((button) => button.addEventListener('click', () => {
    const item = data.results[Number(button.dataset.copyBatchCode)];
    if (item?.message) copyCode(item.message.code, '验证码已复制');
  }));
  document.querySelector('#refresh-mail-batch').addEventListener('click', refreshMailBatch);
  renderIcons();
  clearTimeout(mailBatchRefreshTimer);
  if (waiting && inboxWorkspace.dataset.view === 'batch') mailBatchRefreshTimer = setTimeout(() => refreshMailBatch(), Number(data.refreshAfterSeconds || 15) * 1000);
}

async function refreshMailBatch() {
  if (mailBatchRefreshInFlight || !activeMailBatchTokens.length) return;
  mailBatchRefreshInFlight = true;
  mailBatchErrorBox.textContent = '';
  try {
    renderMailBatch(await request('/api/query/batch', { tokens: activeMailBatchTokens }));
  } catch (error) {
    clearTimeout(mailBatchRefreshTimer);
    mailBatchErrorBox.textContent = error.message;
  } finally {
    mailBatchRefreshInFlight = false;
  }
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
  totpResultBox.innerHTML = `<div class="result-meta totp-result-meta"><strong>当前会话中的 2FA</strong><span>${entries.length} 条独立密钥</span></div><div class="totp-entry-list">${entries.map((item) => `<section class="totp-entry" data-totp-entry="${item.data.id}">
    <div class="totp-entry-head"><div class="totp-identity">${renderTotpAvatar(item.data.issuer)}<div><h2>${escapeHtml(item.data.issuer || '未命名平台')}</h2><p>${escapeHtml(item.data.accountName || `密钥末四位 ${item.data.secretHint}`)}</p></div></div><button class="btn btn-danger btn-icon" type="button" data-remove-totp="${item.data.id}" title="从当前页面移除" aria-label="从当前页面移除"><i data-lucide="x" class="icon"></i></button></div>
    <div class="totp-code-line"><span class="code-value totp-code-value">${escapeHtml(item.data.code)}</span><button class="btn btn-secondary btn-icon" type="button" data-copy-totp="${item.data.id}" title="复制 2FA 验证码" aria-label="复制 2FA 验证码"><i data-lucide="copy" class="icon"></i></button></div>
    <div class="totp-entry-foot"><span class="totp-live-dot"></span><span data-totp-remaining="${item.data.id}">${item.data.remaining} 秒后自动刷新</span><span class="totp-secret-hint">末四位 ${escapeHtml(item.data.secretHint)}</span></div>
  </section>`).join('')}</div>`;
  document.querySelectorAll('[data-copy-totp]').forEach((button) => button.addEventListener('click', () => copyCode(activeTotps.get(button.dataset.copyTotp).data.code, '2FA 验证码已复制')));
  document.querySelectorAll('[data-remove-totp]').forEach((button) => button.addEventListener('click', () => {
    activeTotps.delete(button.dataset.removeTotp);
    renderTotps();
  }));
  renderIcons();
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

document.querySelectorAll('[data-public-view]').forEach((button) => button.addEventListener('click', async () => {
  if (button.dataset.publicView === 'mail') {
    const filter = button.dataset.mailFilter || 'all';
    const changed = mailState.filter !== filter;
    mailState.filter = filter;
    mailListTitle.textContent = filter === 'code' ? '验证码邮件' : '全部邮件';
    setPublicView('mail');
    if (changed) {
      try { await loadMessages({ reset: true }); } catch (error) { mailListStatus.textContent = error.message; }
    }
    return;
  }
  setPublicView(button.dataset.publicView);
}));

mailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailErrorBox.textContent = '';
  const button = mailForm.querySelector('[type="submit"]');
  button.disabled = true;
  mailState.token = mailTokenInput.value.trim();
  try {
    await loadMessages({ reset: true, unlock: true });
    mailTokenInput.value = '';
  } catch (error) {
    mailErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

changeKeyButton.addEventListener('click', () => {
  mailState.token = '';
  mailState.cursor = null;
  mailState.keyword = '';
  mailState.filter = 'all';
  mailState.requestId += 1;
  mailSearchInput.value = '';
  mailMessageList.replaceChildren();
  inboxWorkspace.classList.add('hidden');
  accessView.classList.remove('hidden');
  mailTokenInput.focus();
});

refreshMailButton.addEventListener('click', async () => {
  try { await loadMessages({ reset: true }); } catch (error) { mailListStatus.textContent = error.message; }
});

mailLoadMoreButton.addEventListener('click', async () => {
  try { await loadMessages(); } catch (error) { mailListStatus.textContent = error.message; }
});

mailSearchInput.addEventListener('input', () => {
  clearTimeout(mailSearchTimer);
  clearMailSearchButton.classList.toggle('hidden', !mailSearchInput.value);
  mailSearchTimer = setTimeout(async () => {
    mailState.keyword = mailSearchInput.value.trim();
    try { await loadMessages({ reset: true }); } catch (error) { mailListStatus.textContent = error.message; }
  }, 350);
});

clearMailSearchButton.addEventListener('click', () => {
  mailSearchInput.value = '';
  mailSearchInput.dispatchEvent(new Event('input'));
  mailSearchInput.focus();
});

mailBatchTokensInput.addEventListener('input', () => {
  const count = parseBatchTokens().length;
  mailBatchCount.textContent = String(count);
  mailBatchCount.parentElement.classList.toggle('danger-text', count > 50);
});

mailBatchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailBatchErrorBox.textContent = '';
  const tokens = parseBatchTokens();
  if (!tokens.length) return void (mailBatchErrorBox.textContent = '请至少输入一个查询密钥');
  if (tokens.length > 50) return void (mailBatchErrorBox.textContent = '每次最多查询 50 个密钥');
  const button = mailBatchForm.querySelector('[type="submit"]');
  button.disabled = true;
  clearTimeout(mailBatchRefreshTimer);
  activeMailBatchTokens = tokens;
  try {
    renderMailBatch(await request('/api/query/batch', { tokens }));
  } catch (error) {
    activeMailBatchTokens = [];
    mailBatchErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
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
  } catch (error) {
    totpErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const loadObserver = new IntersectionObserver((entries) => {
  if (entries[0]?.isIntersecting && mailState.cursor && !mailState.loading && inboxWorkspace.dataset.view === 'mail') {
    loadMessages().catch((error) => { mailListStatus.textContent = error.message; });
  }
}, { root: mailListPane, rootMargin: '160px' });
loadObserver.observe(mailLoadSentinel);

renderIcons();
