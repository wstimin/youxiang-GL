'use strict';

const inboxWorkspace = document.querySelector('#inbox-workspace');
const mailForm = document.querySelector('#mail-query-form');
const mailTokenInput = document.querySelector('#mail-token');
const mailErrorBox = document.querySelector('#mail-query-error');
const mailPlaceholder = document.querySelector('#mail-placeholder');
const mailListPane = document.querySelector('#mail-list-pane');
const mailView = document.querySelector('#mail-view');
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
const newMailBanner = document.querySelector('#new-mail-banner');
const mailboxAddress = document.querySelector('#mailbox-address');
const mailboxState = document.querySelector('#mailbox-state');
const mailboxHealthDot = document.querySelector('#mailbox-health-dot');
const mailboxHealthLabel = document.querySelector('#mailbox-health-label');
const mailboxLastSync = document.querySelector('#mailbox-last-sync');
const mailTotalCount = document.querySelector('#mail-total-count');
const mailLastRefresh = document.querySelector('#mail-last-refresh');
const changeKeyButton = document.querySelector('#change-key');
const batchView = document.querySelector('#batch-view');
const batchInboxView = document.querySelector('#batch-inbox-view');
const mailBatchForm = document.querySelector('#mail-batch-form');
const mailBatchTokensInput = document.querySelector('#mail-batch-tokens');
const mailBatchCount = document.querySelector('#mail-batch-count');
const mailBatchErrorBox = document.querySelector('#mail-batch-error');
const mailBatchPlaceholder = document.querySelector('#mail-batch-placeholder');
const mailBatchResultBox = document.querySelector('#mail-batch-result');
const batchInboxForm = document.querySelector('#batch-inbox-form');
const batchInboxTokensInput = document.querySelector('#batch-inbox-tokens');
const batchInboxCount = document.querySelector('#batch-inbox-count');
const batchInboxErrorBox = document.querySelector('#batch-inbox-error');
const batchInboxPlaceholder = document.querySelector('#batch-inbox-placeholder');
const batchInboxResultBox = document.querySelector('#batch-inbox-result');
const batchInboxSummary = document.querySelector('#batch-inbox-summary');
const batchInboxSearchInput = document.querySelector('#batch-inbox-search');
const clearBatchInboxSearchButton = document.querySelector('#clear-batch-inbox-search');
const refreshBatchInboxButton = document.querySelector('#refresh-batch-inbox');
const reimportBatchInboxButton = document.querySelector('#reimport-batch-inbox');
const batchInboxStatus = document.querySelector('#batch-inbox-status');
const batchInboxWorkspace = document.querySelector('#batch-inbox-workspace');
const batchInboxMailboxes = document.querySelector('#batch-inbox-mailboxes');
const batchInboxMessages = document.querySelector('#batch-inbox-messages');
const batchInboxSelectedMailbox = document.querySelector('#batch-inbox-selected-mailbox');
const batchInboxMessageDetail = document.querySelector('#batch-inbox-message-detail');
const batchInboxBackMailboxesButton = document.querySelector('#batch-inbox-back-mailboxes');
const batchInboxImportDialog = document.querySelector('#batch-inbox-import-dialog');
const batchInboxReimportForm = document.querySelector('#batch-inbox-reimport-form');
const batchInboxReimportTokensInput = document.querySelector('#batch-inbox-reimport-tokens');
const batchInboxReimportCount = document.querySelector('#batch-inbox-reimport-count');
const batchInboxReimportError = document.querySelector('#batch-inbox-reimport-error');
const closeBatchInboxImportButton = document.querySelector('#close-batch-inbox-import');
const cancelBatchInboxImportButton = document.querySelector('#cancel-batch-inbox-import');
const totpView = document.querySelector('#totp-view');
const totpForm = document.querySelector('#totp-query-form');
const totpSecretInput = document.querySelector('#totp-secret');
const totpQrFileInput = document.querySelector('#totp-qr-file');
const totpQrUploadButton = document.querySelector('#totp-qr-upload');
const totpErrorBox = document.querySelector('#totp-query-error');
const totpPlaceholder = document.querySelector('#totp-placeholder');
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
  latestId: null,
  lastRefreshAt: null,
  requestId: 0
};
let mailSearchTimer;
let mailRefreshTimer;
let mailRefreshInFlight = false;
let mailBatchRefreshTimer;
let activeMailBatchTokens = [];
let mailBatchRefreshInFlight = false;
let activeBatchInboxTokens = [];
let batchInboxSearchTimer;
let batchInboxInFlight = false;
let batchInboxState = { results: [], keyword: '', selectedMailboxIndex: null, selectedMessageId: null, initialized: false };
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

function formatFolders(folders) {
  return Array.isArray(folders) && folders.length ? folders.join(' / ') : 'INBOX';
}

function formatSyncLabel(value) {
  if (!value) return '等待首次更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return '刚刚更新';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前更新`;
  return `${Math.floor(seconds / 86400)} 天前更新`;
}

function updateMailbox(data) {
  const mailbox = data?.mailbox;
  if (!mailbox) return;
  const stateLabels = { ready: '已连接，只读访问', updating: '正在同步邮件', delayed: '同步稍有延迟', paused: '邮箱已暂停' };
  const healthLabels = { ready: '已连接', updating: '正在同步', delayed: '同步延迟', paused: '已暂停' };
  mailboxAddress.textContent = mailbox.address || '授权邮箱';
  mailboxState.textContent = stateLabels[mailbox.state] || '只读访问';
  mailboxHealthLabel.textContent = healthLabels[mailbox.state] || '只读访问';
  mailboxLastSync.textContent = formatSyncLabel(mailbox.lastSyncedAt);
  mailboxHealthDot.dataset.state = mailbox.state || 'updating';
  mailTotalCount.textContent = String(mailbox.totalMessages ?? 0);
  inboxWorkspace.dataset.mailboxState = mailbox.state || 'updating';
}

function setRefreshLabel() {
  mailLastRefresh.textContent = mailState.lastRefreshAt
    ? formatSyncLabel(mailState.lastRefreshAt)
    : '尚未更新';
}

function scheduleMailRefresh(seconds = 60) {
  clearTimeout(mailRefreshTimer);
  if (!mailState.token) return;
  mailRefreshTimer = setTimeout(() => pollForNewMail(seconds), Math.max(30, seconds) * 1000);
}

async function pollForNewMail(refreshSeconds = 60) {
  if (mailRefreshInFlight || !mailState.token || inboxWorkspace.dataset.view !== 'mail') {
    scheduleMailRefresh(refreshSeconds);
    return;
  }
  mailRefreshInFlight = true;
  const token = mailState.token;
  const requestId = mailState.requestId;
  try {
    const data = await request('/api/query', {
      token,
      cursor: null,
      limit: 1,
      keyword: mailState.keyword,
      status: mailState.filter === 'code' ? 'code' : ''
    });
    if (token !== mailState.token || requestId !== mailState.requestId || inboxWorkspace.dataset.view !== 'mail') return;
    updateMailbox(data);
    const latestId = Number(data.messages?.[0]?.id || 0) || null;
    if (mailState.latestId && latestId && latestId !== mailState.latestId) {
      newMailBanner.classList.remove('hidden');
      renderIcons();
    }
    scheduleMailRefresh(Number(data.mailbox?.refreshAfterSeconds || refreshSeconds));
  } catch (error) {
    if (token === mailState.token && requestId === mailState.requestId) {
      mailListStatus.textContent = error.message;
      scheduleMailRefresh(refreshSeconds);
    }
  } finally {
    mailRefreshInFlight = false;
  }
}

function setPublicView(view) {
  mailView.classList.toggle('hidden', view !== 'mail');
  batchView.classList.toggle('hidden', view !== 'batch');
  batchInboxView.classList.toggle('hidden', view !== 'batch-inbox');
  totpView.classList.toggle('hidden', view !== 'totp');
  inboxWorkspace.dataset.view = view;
  document.querySelectorAll('[data-public-view]').forEach((button) => {
    const isMailFilter = Boolean(button.dataset.mailFilter);
    const active = button.dataset.publicView === view && (!isMailFilter || button.dataset.mailFilter === mailState.filter);
    button.classList.toggle('active', active);
    if (isMailFilter) button.setAttribute('aria-pressed', String(active));
  });
  if (view !== 'batch') clearTimeout(mailBatchRefreshTimer);
  if (view === 'batch' && activeMailBatchTokens.length && mailBatchResultBox.innerHTML) {
    mailBatchRefreshTimer = setTimeout(() => refreshMailBatch(), 15000);
  }
  if (view === 'mail') scheduleMailRefresh();
  else clearTimeout(mailRefreshTimer);
}

function selectAccessMail(filter = 'all') {
  mailState.filter = filter;
  updateMailFilterUi();
  setPublicView('mail');
  document.querySelectorAll('[data-mail-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mailFilter === filter);
  });
  mailTokenInput.focus();
}

function updateMailFilterUi() {
  const codeOnly = mailState.filter === 'code';
  const resultsVisible = mailPlaceholder.classList.contains('hidden');
  mailListTitle.textContent = codeOnly ? '接收验证码' : '邮箱';
  mailSearchInput.placeholder = codeOnly ? '搜索验证码邮件的发件人、主题或摘要' : '搜索发件人、主题或邮件内容';
  refreshMailButton.title = codeOnly ? '刷新验证码' : '刷新邮件';
  refreshMailButton.setAttribute('aria-label', refreshMailButton.title);
  newMailBanner.querySelector('span').textContent = codeOnly ? '有新的验证码，点击查看' : '有新邮件，点击查看';
  const emptyTitle = mailListEmpty.querySelector('strong');
  const emptyDescription = mailListEmpty.querySelector('span');
  emptyTitle.textContent = codeOnly ? '暂时没有有效验证码' : '没有找到邮件';
  emptyDescription.textContent = codeOnly ? '验证码邮件到达后会自动显示。' : '可以刷新或修改搜索条件。';
  mailListPane.classList.toggle('code-mode', resultsVisible && codeOnly);
  mailDetail.classList.toggle('hidden', !resultsVisible || codeOnly);
}

function setMailResultsVisible(visible) {
  mailPlaceholder.classList.toggle('hidden', visible);
  mailListPane.classList.toggle('hidden', !visible);
  mailDetail.classList.toggle('hidden', !visible || mailState.filter === 'code');
  mailListPane.classList.toggle('code-mode', visible && mailState.filter === 'code');
}

function resetMailDetail() {
  mailState.selectedId = null;
  mailDetail.classList.remove('mobile-visible');
  mailDetail.innerHTML = '<div class="public-detail-empty"><span class="public-detail-empty-icon"><i data-lucide="mail-open"></i></span><strong>选择一封邮件</strong><span>点击左侧邮件后，在这里查看邮件内容。</span></div>';
  renderIcons();
}

function renderMessageItem(message) {
  return `<button class="public-message-item" type="button" data-message-id="${message.id}">
    <span class="public-message-row"><span class="public-sender"><span class="public-sender-avatar">${escapeHtml(String(message.sender || '?').trim().charAt(0).toUpperCase() || '?')}</span><strong>${escapeHtml(message.sender || '未知发件人')}</strong></span><time datetime="${escapeHtml(message.receivedAt)}">${escapeHtml(formatMailDate(message.receivedAt))}</time></span>
    <span class="public-message-copy"><span class="public-message-subject">${escapeHtml(message.subject || '无主题')}</span><span class="public-message-preview">${escapeHtml(message.bodyPreview || '这封邮件没有可显示的内容。')}</span></span>
    <i data-lucide="chevron-right" class="public-message-arrow"></i>
  </button>`;
}

function renderCodeItem(message) {
  return `<article class="public-code-item">
    <div class="public-code-main">
      <div class="public-message-row"><span class="public-sender"><span class="public-sender-avatar">${escapeHtml(String(message.sender || '?').trim().charAt(0).toUpperCase() || '?')}</span><strong>${escapeHtml(message.sender || '未知发件人')}</strong></span><time datetime="${escapeHtml(message.receivedAt)}">${escapeHtml(formatMailDate(message.receivedAt, true))}</time></div>
      <strong class="public-code-value">${escapeHtml(message.code || message.codeMasked || '------')}</strong>
      <span class="public-code-subject">${escapeHtml(message.subject || '验证码邮件')}</span>
    </div>
    <button class="btn btn-secondary btn-icon" type="button" data-copy-mail-code="${message.id}" title="复制验证码" aria-label="复制验证码"><i data-lucide="copy" class="icon"></i></button>
  </article>`;
}

function bindMessageItems(messages) {
  if (mailState.filter === 'code') {
    for (const message of messages) {
      const button = mailMessageList.querySelector(`[data-copy-mail-code="${message.id}"]`);
      if (button) button.addEventListener('click', async () => {
        try { await copyCode(message.code, '验证码已复制'); } catch (_error) { mailListStatus.textContent = '复制失败，请手动输入验证码'; }
      });
    }
    return;
  }
  for (const message of messages) {
    const button = mailMessageList.querySelector(`[data-message-id="${message.id}"]`);
    if (button) button.addEventListener('click', () => openMailMessage(message, button));
  }
}

function updateMailListState(loadedCount) {
  mailListEmpty.classList.toggle('hidden', mailMessageList.children.length > 0 || mailState.loading);
  mailLoadMoreButton.classList.toggle('hidden', !mailState.cursor || mailState.loading);
  if (mailState.loading) mailListStatus.textContent = mailMessageList.children.length
    ? mailState.filter === 'code' ? '正在加载更多验证码...' : '正在加载更多邮件...'
    : mailState.filter === 'code' ? '正在接收验证码...' : '正在加载邮件...';
  else if (mailMessageList.children.length) mailListStatus.textContent = loadedCount
    ? mailState.filter === 'code' ? `已接收 ${mailMessageList.children.length} 个验证码` : `已加载 ${mailMessageList.children.length} 封邮件`
    : '';
  else mailListStatus.textContent = '';
}

async function loadMessages({ reset = false, unlock = false } = {}) {
  if (!mailState.token || mailState.loading) return false;
  if (!reset && !mailState.cursor) return false;
  mailState.loading = true;
  const requestId = ++mailState.requestId;
  const token = mailState.token;
  if (reset) {
    mailState.cursor = null;
    mailMessageList.replaceChildren();
    resetMailDetail();
  }
  refreshMailButton.disabled = true;
  updateMailListState(0);
  try {
    const data = await request('/api/query', {
      token,
      cursor: reset ? null : mailState.cursor,
      limit: 40,
      keyword: mailState.keyword,
      status: mailState.filter === 'code' ? 'code' : ''
    });
    if (requestId !== mailState.requestId) return false;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    updateMailbox(data);
    mailMessageList.insertAdjacentHTML('beforeend', messages.map(mailState.filter === 'code' ? renderCodeItem : renderMessageItem).join(''));
    bindMessageItems(messages);
    mailState.cursor = data.nextCursor || null;
    if (reset) {
      mailState.latestId = Number(messages[0]?.id || 0) || null;
      newMailBanner.classList.add('hidden');
    }
    mailState.lastRefreshAt = new Date().toISOString();
    setRefreshLabel();
    scheduleMailRefresh(Number(data.mailbox?.refreshAfterSeconds || 60));
    if (unlock) {
      setMailResultsVisible(true);
      setPublicView('mail');
    }
    renderIcons();
    return true;
  } catch (error) {
    if (unlock && requestId === mailState.requestId) mailState.token = '';
    throw error;
  } finally {
    if (requestId === mailState.requestId) {
      mailState.loading = false;
      refreshMailButton.disabled = false;
      updateMailListState(mailMessageList.children.length);
    }
  }
}

newMailBanner.addEventListener('click', async () => {
  newMailBanner.classList.add('hidden');
  try { await loadMessages({ reset: true }); } catch (error) { mailListStatus.textContent = error.message; }
});

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
    </header>
    <dl class="public-detail-meta">
      <div><dt>发件人</dt><dd>${escapeHtml(detail.sender || '未知发件人')}</dd></div>
      <div><dt>收到时间</dt><dd>${escapeHtml(formatMailDate(detail.receivedAt, true))}</dd></div>
    </dl>
    <section class="public-detail-content"><div class="public-detail-content-label"><i data-lucide="align-left"></i><span>邮件内容</span></div><pre class="public-detail-body"></pre></section>`;
    mailDetail.querySelector('.public-detail-body').textContent = detail.body || '这封邮件没有可显示的内容。';
    mailDetail.querySelector('.public-mobile-back').addEventListener('click', () => mailDetail.classList.remove('mobile-visible'));
    renderIcons();
  } catch (error) {
    mailDetail.innerHTML = `<div class="public-detail-empty"><i data-lucide="circle-alert"></i><strong>正文加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    renderIcons();
  }
}

function parseBatchTokens() {
  return mailBatchTokensInput.value.split(/\r?\n/).map((token) => token.trim()).filter(Boolean);
}

function splitQueryTokens(tokens, size = 50) {
  const batches = [];
  for (let index = 0; index < tokens.length; index += size) batches.push(tokens.slice(index, index + size));
  return batches;
}

async function requestBatchTokens(url, tokens, extra = {}) {
  const results = [];
  for (const [batchIndex, batch] of splitQueryTokens(tokens).entries()) {
    const data = await request(url, { ...extra, tokens: batch });
    for (const item of data.results || []) results.push({ ...item, index: batchIndex * 50 + item.index });
  }
  return { results, refreshAfterSeconds: 15 };
}

function mailBatchStatus(item) {
  if (item.status === 'received') return '<span class="batch-status received"><span></span>已收到</span>';
  if (item.status === 'waiting') return '<span class="batch-status waiting"><span></span>等待中</span>';
  if (item.status === 'invalid_format') return '<span class="batch-status invalid"><span></span>格式错误</span>';
  return '<span class="batch-status invalid"><span></span>密钥无效</span>';
}

function renderMailBatch(data) {
  const received = data.results.filter((item) => item.status === 'received').length;
  const waiting = data.results.filter((item) => item.status === 'waiting').length;
  const invalid = data.results.filter((item) => item.status === 'invalid' || item.status === 'invalid_format').length;
  mailBatchPlaceholder.classList.add('hidden');
  mailBatchResultBox.classList.remove('hidden');
  mailBatchResultBox.innerHTML = `<div class="result-meta batch-result-meta"><strong>查询结果</strong><span>已收到 ${received} · 等待 ${waiting} · 无效 ${invalid}</span></div>
    <div class="batch-result-list">${data.results.map((item) => `<section class="batch-result-row batch-${item.status}">
      <div class="batch-result-identity"><span class="batch-row-index">${item.index + 1}</span><div><strong>查询项 ${item.index + 1}</strong><small>独立查询密钥</small></div></div>
      <div class="batch-result-state">${mailBatchStatus(item)}</div>
      <div class="batch-result-code">${item.message ? `<strong>${escapeHtml(item.message.code)}</strong><small>${escapeHtml(item.message.sender || item.message.subject || '验证码邮件')}</small>` : `<strong>------</strong><small>${item.status === 'invalid_format' ? '请使用 cv_ 密钥或邮箱--密钥格式' : item.status === 'invalid' ? '查询密钥不存在或已失效' : '等待最新验证码'}</small>`}</div>
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
    renderMailBatch(await requestBatchTokens('/api/query/batch', activeMailBatchTokens));
  } catch (error) {
    clearTimeout(mailBatchRefreshTimer);
    mailBatchErrorBox.textContent = error.message;
  } finally {
    mailBatchRefreshInFlight = false;
  }
}

function parseBatchInboxTokens(value = batchInboxTokensInput.value) {
  return value.split(/\r?\n/).map((token) => token.trim()).filter(Boolean);
}

function batchInboxStateLabel(item) {
  if (item.status === 'invalid_format') return '<span class="batch-inbox-state invalid"><span></span>格式错误</span>';
  if (item.status === 'invalid') return '<span class="batch-inbox-state invalid"><span></span>密钥无效</span>';
  if (item.mailbox?.state === 'delayed') return '<span class="batch-inbox-state delayed"><span></span>同步延迟</span>';
  if (item.mailbox?.state === 'paused') return '<span class="batch-inbox-state invalid"><span></span>邮箱已暂停</span>';
  if (Number(item.mailbox?.matchedMessages || 0) > 0) return '<span class="batch-inbox-state ready"><span></span>有邮件</span>';
  return `<span class="batch-inbox-state empty"><span></span>${batchInboxState.keyword ? '无匹配邮件' : '暂无邮件'}</span>`;
}

function renderBatchInboxMessage(message, mailboxIndex) {
  const active = batchInboxState.selectedMailboxIndex === mailboxIndex && Number(batchInboxState.selectedMessageId) === Number(message.id);
  return `<button class="batch-inbox-message ${active ? 'active' : ''}" type="button" data-batch-inbox-message="${message.id}" data-mailbox-index="${mailboxIndex}">
    <span class="batch-inbox-message-avatar">${escapeHtml(String(message.sender || '?').trim().charAt(0).toUpperCase() || '?')}</span>
    <span class="batch-inbox-message-copy"><span class="batch-inbox-message-line"><strong>${escapeHtml(message.sender || '未知发件人')}</strong><time datetime="${escapeHtml(message.receivedAt)}">${escapeHtml(formatMailDate(message.receivedAt))}</time></span><span class="batch-inbox-message-subject">${escapeHtml(message.subject || '无主题')}</span><span class="batch-inbox-message-preview">${escapeHtml(message.bodyPreview || '这封邮件没有可显示的内容。')}</span></span>
    <i data-lucide="chevron-right" class="batch-inbox-message-arrow"></i>
  </button>`;
}

function selectedBatchInboxItem() {
  return batchInboxState.results.find((item) => item.index === batchInboxState.selectedMailboxIndex) || null;
}

function renderBatchInboxMailboxes() {
  batchInboxMailboxes.innerHTML = batchInboxState.results.map((item) => {
    const mailbox = item.mailbox;
    const count = Number(mailbox?.matchedMessages || 0);
    const countLabel = batchInboxState.keyword ? `${count} 封匹配 / ${Number(mailbox?.totalMessages || 0)} 封` : `${Number(mailbox?.totalMessages || 0)} 封`;
    const title = mailbox?.address || `查询项 ${item.index + 1}`;
    const latest = mailbox?.lastMessageAt ? `最近 ${formatMailDate(mailbox.lastMessageAt, true)}` : '最近 7 天无邮件';
    const invalid = item.status === 'invalid' || item.status === 'invalid_format';
    return `<button class="batch-inbox-mailbox ${batchInboxState.selectedMailboxIndex === item.index ? 'active' : ''} ${invalid ? 'is-invalid' : ''}" type="button" data-batch-inbox-mailbox="${item.index}">
      <span class="batch-inbox-group-index">${item.index + 1}</span>
      <span class="batch-inbox-group-identity"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(countLabel)} · ${escapeHtml(latest)}</small></span>
      <span class="batch-inbox-group-state">${batchInboxStateLabel(item)}</span>
      <i data-lucide="chevron-right" class="batch-inbox-mailbox-arrow"></i>
    </button>`;
  }).join('');
  batchInboxMailboxes.querySelectorAll('[data-batch-inbox-mailbox]').forEach((button) => button.addEventListener('click', () => {
    selectBatchInboxMailbox(Number(button.dataset.batchInboxMailbox), { navigate: true });
  }));
}

function renderBatchInboxMessages() {
  const item = selectedBatchInboxItem();
  const title = item?.mailbox?.address || (item ? `查询项 ${item.index + 1}` : '邮件');
  batchInboxSelectedMailbox.textContent = title;
  if (!item) {
    batchInboxMessages.innerHTML = '<div class="batch-inbox-empty"><i data-lucide="mail-search"></i><span>请选择一个邮箱查看邮件。</span></div>';
  } else if (item.status === 'invalid_format') {
    batchInboxMessages.innerHTML = '<div class="batch-inbox-empty"><i data-lucide="key-round"></i><span>格式错误，请使用 cv_ 密钥或邮箱--密钥格式。</span></div>';
  } else if (item.status === 'invalid') {
    batchInboxMessages.innerHTML = '<div class="batch-inbox-empty"><i data-lucide="key-round"></i><span>查询密钥不存在或已失效，请检查后重新导入。</span></div>';
  } else if (item.messages.length) {
    batchInboxMessages.innerHTML = `<div class="batch-inbox-message-list">${item.messages.map((message) => renderBatchInboxMessage(message, item.index)).join('')}</div>${item.nextCursor ? `<div class="batch-inbox-load"><button class="btn btn-secondary" type="button" data-batch-inbox-more="${item.index}"><i data-lucide="chevrons-down" class="icon"></i><span>加载更多</span></button></div>` : ''}`;
  } else {
    batchInboxMessages.innerHTML = `<div class="batch-inbox-empty"><i data-lucide="mail-search"></i><span>${batchInboxState.keyword ? '这个邮箱没有匹配的邮件。' : '这个邮箱最近 7 天没有邮件。'}</span></div>`;
  }
  batchInboxMessages.querySelectorAll('[data-batch-inbox-message]').forEach((button) => button.addEventListener('click', () => {
    const mailboxIndex = Number(button.dataset.mailboxIndex);
    const item = batchInboxState.results.find((result) => result.index === mailboxIndex);
    const message = item?.messages.find((candidate) => Number(candidate.id) === Number(button.dataset.batchInboxMessage));
    if (message) openBatchInboxMessage(mailboxIndex, message);
  }));
  batchInboxMessages.querySelectorAll('[data-batch-inbox-more]').forEach((button) => button.addEventListener('click', () => loadMoreBatchInbox(Number(button.dataset.batchInboxMore), button)));
}

function resetBatchInboxDetail() {
  batchInboxState.selectedMessageId = null;
  batchInboxWorkspace.classList.remove('show-detail');
  batchInboxMessageDetail.innerHTML = '<div class="public-detail-empty"><span class="public-detail-empty-icon"><i data-lucide="mail-open"></i></span><strong>选择一封邮件</strong><span>点击中间的邮件后，在这里查看邮件内容。</span></div>';
}

function selectBatchInboxMailbox(index, { navigate = false } = {}) {
  if (!batchInboxState.results.some((item) => item.index === index)) return;
  const changed = batchInboxState.selectedMailboxIndex !== index;
  batchInboxState.selectedMailboxIndex = index;
  if (changed) resetBatchInboxDetail();
  renderBatchInboxMailboxes();
  renderBatchInboxMessages();
  if (navigate) {
    batchInboxWorkspace.classList.add('show-messages');
    batchInboxWorkspace.classList.remove('show-detail');
  }
  renderIcons();
}

function renderBatchInbox() {
  const results = batchInboxState.results;
  const valid = results.filter((item) => item.status !== 'invalid' && item.status !== 'invalid_format');
  const invalid = results.length - valid.length;
  const withMail = valid.filter((item) => Number(item.mailbox?.matchedMessages || 0) > 0).length;
  const total = valid.reduce((sum, item) => sum + Number(item.mailbox?.totalMessages || 0), 0);
  const matched = valid.reduce((sum, item) => sum + Number(item.mailbox?.matchedMessages || 0), 0);
  batchInboxSummary.innerHTML = `<div><span>邮箱</span><strong>${valid.length}</strong></div><div><span>${batchInboxState.keyword ? '匹配邮箱' : '有邮件'}</span><strong>${withMail}</strong></div><div><span>${batchInboxState.keyword ? '匹配邮件' : '7 天邮件'}</span><strong>${batchInboxState.keyword ? matched : total}</strong></div><div><span>无效密钥</span><strong>${invalid}</strong></div>`;
  renderBatchInboxMailboxes();
  renderBatchInboxMessages();
  batchInboxStatus.textContent = batchInboxState.keyword ? `正在显示“${batchInboxState.keyword}”的分组搜索结果` : `已加载 ${results.length} 个查询项`;
  renderIcons();
}

async function loadBatchInbox({ preserveSelection = true, errorBox = batchInboxErrorBox } = {}) {
  if (batchInboxInFlight || !activeBatchInboxTokens.length) return;
  batchInboxInFlight = true;
  errorBox.textContent = '';
  batchInboxStatus.textContent = '正在查询最近 7 天邮件...';
  refreshBatchInboxButton.disabled = true;
  const previousItem = selectedBatchInboxItem();
  const previousAddress = previousItem?.mailbox?.address || '';
  const previousIndex = batchInboxState.selectedMailboxIndex;
  try {
    const keyword = batchInboxSearchInput.value.trim();
    const data = await requestBatchTokens('/api/query/batch-inbox', activeBatchInboxTokens, { keyword, limitPerMailbox: 20 });
    batchInboxState.results = Array.isArray(data.results) ? data.results : [];
    batchInboxState.keyword = keyword;
    const preserved = preserveSelection && (batchInboxState.results.find((item) => previousAddress && item.mailbox?.address === previousAddress)
      || batchInboxState.results.find((item) => item.index === previousIndex));
    const firstWithMail = batchInboxState.results.find((item) => item.status !== 'invalid' && item.status !== 'invalid_format' && Number(item.mailbox?.matchedMessages || 0) > 0);
    const firstValid = batchInboxState.results.find((item) => item.status !== 'invalid' && item.status !== 'invalid_format');
    const initial = preserved || firstWithMail || firstValid || batchInboxState.results[0] || null;
    batchInboxState.selectedMailboxIndex = initial?.index ?? null;
    batchInboxState.selectedMessageId = null;
    batchInboxState.initialized = true;
    batchInboxPlaceholder.classList.add('hidden');
    batchInboxResultBox.classList.remove('hidden');
    batchInboxForm.classList.add('hidden');
    batchInboxWorkspace.classList.remove('show-detail');
    resetBatchInboxDetail();
    renderBatchInbox();
    return true;
  } catch (error) {
    batchInboxStatus.textContent = '';
    errorBox.textContent = error.message;
    return false;
  } finally {
    batchInboxInFlight = false;
    refreshBatchInboxButton.disabled = false;
  }
}

async function loadMoreBatchInbox(index, button) {
  const item = batchInboxState.results.find((result) => result.index === index);
  const token = activeBatchInboxTokens[index];
  if (!item?.nextCursor || !token) return;
  button.disabled = true;
  try {
    const data = await request('/api/query/batch-inbox', {
      tokens: [token],
      keyword: batchInboxState.keyword,
      limitPerMailbox: 20,
      cursor: item.nextCursor
    });
    const next = data.results?.[0];
    if (!next || next.status === 'invalid' || next.status === 'invalid_format') throw new Error('这个邮箱的查询密钥无效');
    item.messages.push(...next.messages);
    item.nextCursor = next.nextCursor;
    renderBatchInboxMessages();
    renderIcons();
  } catch (error) {
    batchInboxErrorBox.textContent = error.message;
    button.disabled = false;
  }
}

async function openBatchInboxMessage(index, message) {
  const token = activeBatchInboxTokens[index];
  if (!token) return;
  batchInboxState.selectedMailboxIndex = index;
  batchInboxState.selectedMessageId = Number(message.id);
  renderBatchInboxMailboxes();
  renderBatchInboxMessages();
  batchInboxWorkspace.classList.add('show-messages', 'show-detail');
  batchInboxMessageDetail.innerHTML = '<div class="public-detail-loading"><span class="public-spinner"></span><span>正在加载邮件正文...</span></div>';
  try {
    const data = await request('/api/query/message', { token, messageId: Number(message.id) });
    if (batchInboxState.selectedMailboxIndex !== index || Number(batchInboxState.selectedMessageId) !== Number(message.id)) return;
    const detail = data.message;
    batchInboxMessageDetail.innerHTML = `<header class="public-detail-head"><button class="public-mobile-back" type="button" data-batch-inbox-back-messages title="返回邮件列表" aria-label="返回邮件列表"><i data-lucide="arrow-left"></i></button><div><span class="pane-kicker">MESSAGE</span><h1>${escapeHtml(detail.subject || '无主题')}</h1></div></header><dl class="public-detail-meta"><div><dt>发件人</dt><dd>${escapeHtml(detail.sender || '未知发件人')}</dd></div><div><dt>收到时间</dt><dd>${escapeHtml(formatMailDate(detail.receivedAt, true))}</dd></div></dl><section class="public-detail-content"><div class="public-detail-content-label"><i data-lucide="align-left"></i><span>邮件内容</span></div><pre class="public-detail-body"></pre></section>`;
    batchInboxMessageDetail.querySelector('.public-detail-body').textContent = detail.body || '这封邮件没有可显示的内容。';
    batchInboxMessageDetail.querySelector('[data-batch-inbox-back-messages]').addEventListener('click', () => batchInboxWorkspace.classList.remove('show-detail'));
    renderIcons();
  } catch (error) {
    batchInboxMessageDetail.innerHTML = `<div class="batch-inbox-detail-error"><i data-lucide="circle-alert"></i><strong>正文加载失败</strong><span>${escapeHtml(error.message)}</span><button class="btn btn-secondary" type="button" data-batch-inbox-back-messages>返回邮件列表</button></div>`;
    batchInboxMessageDetail.querySelector('[data-batch-inbox-back-messages]').addEventListener('click', () => batchInboxWorkspace.classList.remove('show-detail'));
    renderIcons();
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
  totpPlaceholder.classList.toggle('hidden', Boolean(entries.length));
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
    const filter = button.dataset.mailFilter || mailState.filter || 'all';
    if (!mailState.token) {
      selectAccessMail(filter);
      return;
    }
    const changed = mailState.filter !== filter;
    mailState.filter = filter;
    document.querySelectorAll('[data-mail-filter]').forEach((action) => {
      action.classList.toggle('active', action.dataset.mailFilter === filter);
    });
    updateMailFilterUi();
    setPublicView('mail');
    if (changed) {
      try { await loadMessages({ reset: true }); } catch (error) { mailListStatus.textContent = error.message; }
    }
    return;
  }
  setPublicView(button.dataset.publicView);
}));

setMailResultsVisible(false);
selectAccessMail('all');

mailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailErrorBox.textContent = '';
  const button = event.submitter || mailForm.querySelector('[type="submit"]');
  mailState.filter = button.dataset.mailFilter || mailState.filter || 'all';
  updateMailFilterUi();
  document.querySelectorAll('[data-mail-filter]').forEach((action) => {
    action.classList.toggle('active', action.dataset.mailFilter === mailState.filter);
  });
  button.disabled = true;
  const nextToken = mailTokenInput.value.trim();
  if (nextToken) mailState.token = nextToken;
  try {
    if (!mailState.token) throw new Error('请输入查询密钥');
    await loadMessages({ reset: true, unlock: true });
    mailTokenInput.value = '';
    mailTokenInput.required = false;
  } catch (error) {
    mailErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

changeKeyButton.addEventListener('click', () => {
  clearTimeout(mailRefreshTimer);
  mailState.token = '';
  mailState.cursor = null;
  mailState.keyword = '';
  mailState.filter = 'all';
  mailState.latestId = null;
  mailState.lastRefreshAt = null;
  mailState.loading = false;
  mailState.requestId += 1;
  mailTokenInput.required = true;
  mailSearchInput.value = '';
  mailMessageList.replaceChildren();
  resetMailDetail();
  setMailResultsVisible(false);
  selectAccessMail('all');
});

refreshMailButton.addEventListener('click', async () => {
  try {
    newMailBanner.classList.add('hidden');
    await loadMessages({ reset: true });
  } catch (error) { mailListStatus.textContent = error.message; }
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
  mailBatchCount.parentElement.classList.remove('danger-text');
});

mailBatchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  mailBatchErrorBox.textContent = '';
  const tokens = parseBatchTokens();
  if (!tokens.length) return void (mailBatchErrorBox.textContent = '请至少输入一个查询密钥');
  const button = mailBatchForm.querySelector('[type="submit"]');
  button.disabled = true;
  clearTimeout(mailBatchRefreshTimer);
  activeMailBatchTokens = tokens;
  try {
    renderMailBatch(await requestBatchTokens('/api/query/batch', tokens));
  } catch (error) {
    activeMailBatchTokens = [];
    mailBatchErrorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

batchInboxTokensInput.addEventListener('input', () => {
  const count = parseBatchInboxTokens().length;
  batchInboxCount.textContent = String(count);
  batchInboxCount.parentElement.classList.remove('danger-text');
});

batchInboxForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  batchInboxErrorBox.textContent = '';
  const tokens = parseBatchInboxTokens();
  if (!tokens.length) return void (batchInboxErrorBox.textContent = '请至少输入一个查询密钥');
  const button = batchInboxForm.querySelector('[type="submit"]');
  button.disabled = true;
  activeBatchInboxTokens = tokens;
  batchInboxState = { results: [], keyword: '', selectedMailboxIndex: null, selectedMessageId: null, initialized: false };
  batchInboxSearchInput.value = '';
  clearBatchInboxSearchButton.classList.add('hidden');
  try {
    await loadBatchInbox({ preserveSelection: false });
  } finally {
    button.disabled = false;
  }
});

batchInboxSearchInput.addEventListener('input', () => {
  clearTimeout(batchInboxSearchTimer);
  clearBatchInboxSearchButton.classList.toggle('hidden', !batchInboxSearchInput.value);
  if (!activeBatchInboxTokens.length) return;
  batchInboxSearchTimer = setTimeout(() => loadBatchInbox(), 350);
});

clearBatchInboxSearchButton.addEventListener('click', () => {
  batchInboxSearchInput.value = '';
  batchInboxSearchInput.dispatchEvent(new Event('input'));
  batchInboxSearchInput.focus();
});

refreshBatchInboxButton.addEventListener('click', () => loadBatchInbox());
batchInboxBackMailboxesButton.addEventListener('click', () => batchInboxWorkspace.classList.remove('show-messages', 'show-detail'));

reimportBatchInboxButton.addEventListener('click', () => {
  clearTimeout(batchInboxSearchTimer);
  batchInboxReimportTokensInput.value = activeBatchInboxTokens.join('\n');
  batchInboxReimportCount.textContent = String(activeBatchInboxTokens.length);
  batchInboxReimportError.textContent = '';
  batchInboxImportDialog.showModal();
  batchInboxReimportTokensInput.focus();
});

batchInboxReimportTokensInput.addEventListener('input', () => {
  batchInboxReimportCount.textContent = String(parseBatchInboxTokens(batchInboxReimportTokensInput.value).length);
  batchInboxReimportError.textContent = '';
});

closeBatchInboxImportButton.addEventListener('click', () => batchInboxImportDialog.close());
cancelBatchInboxImportButton.addEventListener('click', () => batchInboxImportDialog.close());
batchInboxImportDialog.addEventListener('click', (event) => {
  if (event.target === batchInboxImportDialog) batchInboxImportDialog.close();
});

batchInboxReimportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const tokens = parseBatchInboxTokens(batchInboxReimportTokensInput.value);
  if (!tokens.length) return void (batchInboxReimportError.textContent = '请至少输入一个查询密钥');
  const button = batchInboxReimportForm.querySelector('[type="submit"]');
  const previousTokens = activeBatchInboxTokens;
  button.disabled = true;
  activeBatchInboxTokens = tokens;
  const loaded = await loadBatchInbox({ preserveSelection: true, errorBox: batchInboxReimportError });
  if (loaded) {
    batchInboxTokensInput.value = tokens.join('\n');
    batchInboxCount.textContent = String(tokens.length);
    batchInboxImportDialog.close();
  } else {
    activeBatchInboxTokens = previousTokens;
  }
  button.disabled = false;
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
