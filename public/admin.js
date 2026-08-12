'use strict';

const state = { data: null, csrfToken: '', importPollTimer: null };
const inbox = { accountId: '', cursor: '', accountPage: 1, accountHasMore: false, messageHasMore: false, loading: false };
const modalRoot = document.querySelector('#modal-root');
const toast = document.querySelector('#toast');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '暂无';
}

function formatFolders(folders) {
  return Array.isArray(folders) && folders.length ? folders.join(' / ') : 'INBOX';
}

function toastMessage(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2200);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  if (response.status === 401) {
    location.replace('/admin/login');
    throw new Error('登录已失效');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}

function empty(text) { return `<div class="empty">${escapeHtml(text)}</div>`; }

function table(headers, rows) {
  if (!rows.length) return empty('暂无记录');
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function badge(status, enabled = true) {
  if (!enabled) return '<span class="badge off">已停用</span>';
  if (status === 'connecting') return '<span class="badge off">正在连接</span>';
  if (status === 'syncing') return '<span class="badge off">正在同步</span>';
  if (status === 'error') return '<span class="badge error">连接异常</span>';
  if (status === 'connected') return '<span class="badge">已连接</span>';
  return '<span class="badge off">等待同步</span>';
}

const auditActionLabels = Object.freeze({
  query_failed: '查询失败',
  query_success: '查询成功',
  query_message_success: '邮件正文查询成功',
  query_batch_failed: '批量查询失败',
  query_batch_success: '批量查询成功',
  totp_converted: '2FA 转换成功',
  totp_failed: '2FA 转换失败',
  login_failed: '登录失败',
  login_success: '登录成功',
  login_totp_failed: '登录动态验证码失败',
  login_totp_success: '登录动态验证码成功',
  mail_sync_requested: '已请求邮箱同步',
  session_revoked: '已退出指定会话',
  other_sessions_revoked: '已退出其他会话',
  mail_account_saved: '已保存母邮箱',
  mail_account_edited: '已编辑母邮箱',
  mail_account_secret_reveal_failed: '查看邮箱凭据失败',
  mail_account_secret_revealed: '已查看邮箱凭据',
  mail_account_toggled: '已切换母邮箱状态',
  mail_account_deleted: '已删除母邮箱',
  mail_accounts_imported: '已创建批量接入任务',
  mail_import_retried: '已重试导入失败项',
  admin_message_opened: '已查看聚合邮件正文',
  alias_created: '已创建邮箱',
  alias_edited: '已编辑邮箱',
  aliases_export_prepared: '已准备邮箱密钥导出',
  aliases_exported: '已导出邮箱密钥',
  aliases_imported: '已批量导入邮箱',
  alias_token_regenerated: '已重置查询密钥',
  alias_toggled: '已切换邮箱状态',
  alias_secrets_reveal_failed: '查看查询密钥失败',
  alias_secrets_revealed: '已查看查询密钥',
  totp_secret_reveal_failed: '查看 2FA 密钥失败',
  totp_secret_revealed: '已查看 2FA 密钥',
  totp_entry_edited: '已编辑 2FA 记录',
  totp_entry_deleted: '已删除 2FA 记录',
  alias_deleted: '已删除邮箱',
  totp_enabled: '已启用管理员 TOTP',
  password_changed: '已修改登录密码'
});

function auditActorLabel(actor) {
  const value = String(actor || '').trim();
  if (value === 'public') return '公开查询端';
  if (value === 'unknown') return '未知用户';
  if (value === 'admin-challenge') return '管理员二次验证';
  const userMatch = value.match(/^user:(\d+)$/);
  if (userMatch) return `管理员 #${userMatch[1]}`;
  const aliasMatch = value.match(/^alias:(\d+)$/);
  if (aliasMatch) return `邮箱 #${aliasMatch[1]}`;
  return value;
}

function auditActionLabel(action) {
  const value = String(action || '').trim();
  return auditActionLabels[value] || value || '系统操作';
}

function auditDetailLabel(detail) {
  const value = String(detail || '').trim();
  if (!value) return '—';
  const directLabels = {
    'invalid token format': '查询密钥格式无效',
    'unknown token': '查询密钥不存在',
    'invalid input': '输入无效'
  };
  if (directLabels[value]) return directLabels[value];
  const requestedMatch = value.match(/^requested=(\d+);invalid=(\d+)$/);
  if (requestedMatch) return `请求 ${requestedMatch[1]} 条，无效 ${requestedMatch[2]} 条`;
  const exportedMatch = value.match(/^exported=(\d+);skipped=(\d+)$/);
  if (exportedMatch) return `导出 ${exportedMatch[1]} 条，跳过 ${exportedMatch[2]} 条`;
  const createdMatch = value.match(/^created=(\d+);skipped=(\d+)$/);
  if (createdMatch) return `创建 ${createdMatch[1]} 条，跳过 ${createdMatch[2]} 条`;
  return value;
}

function auditRecordDetail(row) {
  const target = String(row.target || '').trim();
  const detail = auditDetailLabel(row.detail);
  if (row.action === 'other_sessions_revoked' && /^\d+$/.test(String(row.detail || '').trim())) {
    return `共退出 ${String(row.detail).trim()} 个会话`;
  }
  if (target && detail !== '—') return `${target} · ${detail}`;
  return target || detail;
}

function mailErrorLabel(error) {
  const value = String(error || '').trim();
  if (!value) return '';
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed/i.test(value)) {
    return '邮箱登录失败，请检查邮箱地址和应用专用密码';
  }
  if (/ETIMEDOUT|CONNECT_TIMEOUT|failed to establish connection in required time|timed out/i.test(value)) {
    return '连接邮箱服务器超时，请检查服务器出站网络和 TCP 993 端口';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(value)) {
    return '无法解析邮箱服务器地址，请检查服务器 DNS';
  }
  if (/ECONNREFUSED/i.test(value)) return '邮箱服务器拒绝连接';
  if (/ECONNRESET|EPIPE/i.test(value)) return '与邮箱服务器的连接被中断';
  if (/certificate|TLS|handshake/i.test(value)) return '邮箱服务器 TLS 安全连接失败';
  return `邮箱同步失败：${value}`;
}

function matches(value, query) {
  return String(value || '').toLowerCase().includes(query);
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

const mailProviderDetails = Object.freeze({
  icloud: {
    label: 'iCloud',
    host: 'imap.mail.me.com:993',
    passwordLabel: 'Apple App 专用密码',
    passwordPlaceholder: 'xxxx-xxxx-xxxx-xxxx',
    help: '请在 Apple 账户中开启双重认证并创建 App 专用密码，不要填写 Apple ID 日常登录密码。'
  },
  gmail: {
    label: 'Gmail',
    host: 'imap.gmail.com:993',
    passwordLabel: 'Google 应用专用密码',
    passwordPlaceholder: '16 位应用专用密码',
    help: 'Google 账户需要开启两步验证并创建应用专用密码，同时确保该账户允许使用 IMAP。'
  },
  outlook: {
    label: 'Outlook',
    host: 'outlook.office365.com:993',
    passwordLabel: 'Outlook IMAP 授权密码',
    passwordPlaceholder: '密码或应用专用密码',
    help: '仅支持允许传统 IMAP 凭据登录的账户。强制现代认证的 Microsoft 账户或企业租户需要 OAuth，本版本暂不支持。'
  }
});

function inferMailProvider(account = {}) {
  if (mailProviderDetails[account.provider]) return account.provider;
  if (account.host === 'imap.gmail.com') return 'gmail';
  if (account.host === 'outlook.office365.com' || account.host === 'imap-mail.outlook.com') return 'outlook';
  return 'icloud';
}

function mailProviderOptions(selected = 'icloud') {
  return Object.entries(mailProviderDetails).map(([value, detail]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${detail.label}</option>`
  ).join('');
}

function updateMailProviderFields(prefix, options = {}) {
  const provider = document.querySelector(`#${prefix}-provider`).value;
  const detail = mailProviderDetails[provider];
  document.querySelector(`#${prefix}-password-label`).textContent = detail.passwordLabel;
  document.querySelector(`#${prefix}-password`).placeholder = options.keepPassword
    ? '留空表示不修改'
    : detail.passwordPlaceholder;
  document.querySelector(`#${prefix}-imap`).value = detail.host;
  document.querySelector(`#${prefix}-help`).textContent = detail.help;
}

function sessionDevice(userAgent) {
  const value = String(userAgent || '未知设备');
  if (/iphone|ipad/i.test(value)) return 'Apple 移动设备';
  if (/android/i.test(value)) return 'Android 设备';
  if (/windows/i.test(value)) return 'Windows 浏览器';
  if (/macintosh|mac os/i.test(value)) return 'Mac 浏览器';
  if (/linux/i.test(value)) return 'Linux 浏览器';
  return value.slice(0, 70);
}

function render() {
  const data = state.data;
  document.querySelector('#admin-email').textContent = data.admin.email;
  const connected = data.accounts.filter((row) => row.enabled && row.status === 'connected').length;
  document.querySelector('#stats').innerHTML = [
    ['inbox', '在线母邮箱', `${connected}/${data.accounts.length}`],
    ['at-sign', '启用邮箱', data.aliases.filter((row) => row.enabled).length],
    ['search-check', '今日成功查询', data.metrics.queries_today],
    ['shield-alert', '今日失败查询', data.metrics.query_failures_today],
    ['fingerprint', '今日 2FA 转换', data.metrics.totp_conversions_today],
    ['log-in', '今日登录失败', data.metrics.login_failures_today]
  ].map(([icon, label, value]) => `<div class="stat"><div class="stat-label"><i data-lucide="${icon}" class="icon"></i>${label}</div><div class="stat-value">${value}</div></div>`).join('');

  const worker = data.runtime.find((row) => row.service === 'worker');
  const workerFresh = Boolean(worker?.fresh);
  document.querySelector('#runtime-summary').textContent = workerFresh ? '所有核心服务正常' : '邮件 Worker 需要检查';
  document.querySelector('#runtime-status').innerHTML = [
    ['Web 服务', true, '后台接口已连接'],
    ['PostgreSQL', true, '数据库查询正常'],
    ['邮件 Worker', workerFresh, workerFresh ? `最近心跳 ${formatDate(worker.heartbeat_at)}` : '未检测到近期心跳']
  ].map(([label, healthy, detail]) => `<div class="status-item"><strong><span class="status-dot${healthy ? '' : ' warn'}"></span>${label}</strong><span class="muted">${escapeHtml(detail)}</span></div>`).join('');

  const aliasQuery = document.querySelector('#alias-search').value.trim().toLowerCase();
  const totpQuery = document.querySelector('#totp-search').value.trim().toLowerCase();
  const messageQuery = document.querySelector('#message-search').value.trim().toLowerCase();
  const filteredAliases = data.aliases.filter((row) => matches(row.address, aliasQuery) || matches(row.label, aliasQuery));
  const filteredTotps = data.totpEntries.filter((row) => matches(row.issuer, totpQuery) || matches(row.account_name, totpQuery) || matches(row.secret_hint, totpQuery));
  const filteredMessages = data.recent.filter((row) => matches(row.address, messageQuery) || matches(row.sender, messageQuery) || matches(row.subject, messageQuery));
  document.querySelector('#alias-count').textContent = `${filteredAliases.length}/${data.aliases.length} 条`;
  document.querySelector('#totp-count').textContent = `${filteredTotps.length}/${data.totpEntries.length} 条`;
  const messageCount = document.querySelector('#message-count');
  if (messageCount) messageCount.textContent = `${filteredMessages.length}/${data.recent.length} 条`;

  const recentRows = data.recent.slice(0, 10).map((row) => `<tr><td>${escapeHtml(row.address || '未匹配')}</td><td>${escapeHtml(formatFolders(row.mailbox_paths))}</td><td>${escapeHtml(row.sender)}</td><td>${escapeHtml(row.subject)}</td><td>${formatDate(row.received_at)}</td></tr>`);
  document.querySelector('#overview-recent').innerHTML = table(['邮箱', '文件夹', '发件人', '主题', '收到时间'], recentRows);
  const legacyMessageTable = document.querySelector('#messages-table');
  if (legacyMessageTable) legacyMessageTable.innerHTML = table(['邮箱', '发件人', '主题', '收到时间'], filteredMessages.map((row) => `<tr><td>${escapeHtml(row.address || '未匹配')}</td><td>${escapeHtml(row.sender)}</td><td>${escapeHtml(row.subject)}</td><td>${formatDate(row.received_at)}</td></tr>`));
  document.querySelector('#unmatched-table').innerHTML = table(['文件夹', '发件人', '主题', '收件信息', '收到时间'], data.unmatched.map((row) => `<tr><td>${escapeHtml(formatFolders(row.mailbox_paths))}</td><td>${escapeHtml(row.sender)}</td><td>${escapeHtml(row.subject)}</td><td>${escapeHtml(row.recipient_headers.slice(0, 120))}</td><td>${formatDate(row.received_at)}</td></tr>`));
  document.querySelector('#audit-table').innerHTML = table(['操作者', '操作', '对象/详情', '时间'], data.audit.slice(0, 12).map((row) => `<tr><td>${escapeHtml(auditActorLabel(row.actor))}</td><td>${escapeHtml(auditActionLabel(row.action))}</td><td>${escapeHtml(auditRecordDetail(row))}</td><td>${formatDate(row.created_at)}</td></tr>`));

  document.querySelector('#accounts-table').innerHTML = table(['邮箱', '服务商', 'IMAP', '状态', '最后同步', '操作'], data.accounts.map((row) => `<tr><td><strong>${escapeHtml(row.email)}</strong>${row.last_error ? `<br><small class="danger-text">${escapeHtml(mailErrorLabel(row.last_error))}</small>` : ''}</td><td>${escapeHtml(mailProviderDetails[inferMailProvider(row)].label)}</td><td>${escapeHtml(row.host)}:${row.port}</td><td>${badge(row.status, row.enabled)}</td><td>${formatDate(row.last_synced_at)}${row.sync_requested_at ? '<br><small class="muted">已加入优先同步队列</small>' : ''}</td><td><div class="actions"><button class="btn btn-secondary btn-icon" title="编辑母邮箱" aria-label="编辑母邮箱" data-account-edit="${row.id}"><i data-lucide="pencil" class="icon"></i></button><button class="btn btn-secondary" data-account-secrets="${row.id}"><i data-lucide="eye" class="icon"></i><span>查看凭据</span></button><button class="btn btn-secondary btn-icon" title="请求同步" aria-label="请求同步" data-account-sync="${row.id}" ${row.enabled ? '' : 'disabled'}><i data-lucide="refresh-cw" class="icon"></i></button><button class="btn btn-secondary" data-account-toggle="${row.id}">${row.enabled ? '暂停' : '启用'}</button><button class="btn btn-danger btn-icon" title="删除" aria-label="删除" data-account-delete="${row.id}"><i data-lucide="trash-2" class="icon"></i></button></div></td></tr>`));
  document.querySelector('#aliases-table').innerHTML = table(['邮箱', '备注', '密钥提示', '状态', '最近收信', '操作'], filteredAliases.map((row) => `<tr><td><strong>${escapeHtml(row.address)}</strong></td><td>${escapeHtml(row.label || '-')}</td><td>末六位 ${escapeHtml(row.token_hint || '-')}${row.token_recoverable ? '' : '<br><small class="muted">旧密钥不可恢复</small>'}</td><td>${row.enabled ? '<span class="badge">已启用</span>' : '<span class="badge off">已停用</span>'}</td><td>${formatDate(row.last_received_at)}</td><td><div class="actions"><button class="btn btn-secondary btn-icon" data-alias-edit="${row.id}" title="编辑邮箱" aria-label="编辑邮箱"><i data-lucide="pencil" class="icon"></i></button><button class="btn btn-secondary" data-alias-secrets="${row.id}"><i data-lucide="eye" class="icon"></i><span>查看密钥</span></button><button class="btn btn-secondary" data-alias-reset="${row.id}">重置密钥</button><button class="btn btn-secondary" data-alias-toggle="${row.id}">${row.enabled ? '停用' : '启用'}</button><button class="btn btn-danger btn-icon" title="删除邮箱" aria-label="删除邮箱" data-alias-delete="${row.id}"><i data-lucide="trash-2" class="icon"></i></button></div></td></tr>`));
  document.querySelector('#totp-entries-table').innerHTML = table(['平台', '账号', '密钥提示', '来源', '最近使用', '操作'], filteredTotps.map((row) => `<tr><td><div class="admin-totp-platform">${renderTotpAvatar(row.issuer)}<strong>${escapeHtml(row.issuer || '未命名平台')}</strong></div></td><td>${escapeHtml(row.account_name || '-')}</td><td>末四位 ${escapeHtml(row.secret_hint || '-')}</td><td>${row.legacy_alias_address ? `由旧配置迁移<br><small class="muted">${escapeHtml(row.legacy_alias_address)}</small>` : '前端直接添加'}</td><td>${formatDate(row.last_used_at || row.created_at)}</td><td><div class="actions"><button class="btn btn-secondary btn-icon" data-totp-edit="${row.id}" title="编辑 2FA 备注" aria-label="编辑 2FA 备注"><i data-lucide="pencil" class="icon"></i></button><button class="btn btn-secondary" data-totp-secrets="${row.id}"><i data-lucide="eye" class="icon"></i><span>查看密钥与验证码</span></button><button class="btn btn-danger btn-icon" title="删除 2FA" aria-label="删除 2FA" data-totp-delete="${row.id}"><i data-lucide="trash-2" class="icon"></i></button></div></td></tr>`));
  document.querySelector('#sessions-table').innerHTML = table(['设备', '登录时间', '过期时间', '状态', '操作'], data.sessions.map((row) => `<tr><td><strong>${escapeHtml(sessionDevice(row.user_agent))}</strong></td><td>${formatDate(row.created_at)}</td><td>${formatDate(row.expires_at)}</td><td>${row.current ? '<span class="badge">当前会话</span>' : '<span class="badge off">其他会话</span>'}</td><td>${row.current ? '<span class="muted">正在使用</span>' : `<button class="btn btn-danger" data-session-revoke="${row.session_id}">退出此设备</button>`}</td></tr>`));

  document.querySelector('#totp-status').textContent = data.admin.totpEnabled ? 'TOTP 动态验证码已启用。' : 'TOTP 尚未启用，管理员登录目前只使用密码。';
  document.querySelector('#setup-totp').classList.toggle('hidden', data.admin.totpEnabled);
  bindRowActions();
  lucide.createIcons();
  if (document.querySelector('#messages')?.classList.contains('active')) loadInbox().catch(() => {});
}

function renderInboxMailboxes(accounts) {
  const tree = document.querySelector('#mailbox-tree');
  if (!tree) return;
  tree.innerHTML = accounts.map((account) => `<button class="mailbox-account${String(inbox.accountId) === String(account.id) ? ' active' : ''}" type="button" data-inbox-account="${account.id}"><span class="mailbox-account-main"><i data-lucide="inbox" class="icon"></i><strong>${escapeHtml(account.email)}</strong></span><span class="mailbox-account-meta"><span class="badge ${account.enabled ? '' : 'off'}">${escapeHtml(account.sync_status === 'completed' ? '同步完成' : account.sync_status === 'syncing' ? '正在同步' : account.sync_status === 'connecting' ? '正在连接' : account.verification_status === 'login_failed' ? '登录失败' : '等待验证')}</span><small>${account.alias_count} 个邮箱 · ${account.message_count} 封</small></span></button>`).join('') || empty('暂无邮箱');
  tree.querySelectorAll('[data-inbox-account]').forEach((button) => button.addEventListener('click', () => {
    inbox.accountId = button.dataset.inboxAccount;
    inbox.cursor = '';
    loadInboxMessages().catch((error) => toastMessage(error.message));
  }));
  lucide.createIcons();
}

async function loadInboxMailboxes(reset = false) {
  if (reset) inbox.accountPage = 1;
  const keyword = document.querySelector('#message-search')?.value.trim() || '';
  const data = await api(`/api/admin/mailbox-tree?keyword=${encodeURIComponent(keyword)}&page=${inbox.accountPage}&limit=20`);
  inbox.accounts = reset ? data.accounts : [...(inbox.accounts || []), ...data.accounts];
  renderInboxMailboxes(inbox.accounts);
  inbox.accountHasMore = data.pagination.hasMore;
  document.querySelector('#load-more-mailboxes')?.classList.toggle('hidden', !inbox.accountHasMore);
}

function renderInboxMessages(messages, append = false) {
  const list = document.querySelector('#inbox-message-list');
  if (!list) return;
  const markup = messages.map((message) => `<button class="inbox-message${String(message.id) === String(inbox.selectedId) ? ' active' : ''}" type="button" data-inbox-message="${message.id}"><div class="inbox-message-head"><strong>${escapeHtml(message.sender || '未知发件人')}</strong><time>${escapeHtml(formatDate(message.receivedAt))}</time></div><h3>${escapeHtml(message.subject || '无主题')}</h3><p>${escapeHtml(message.bodyPreview || '无邮件摘要')}</p><div class="inbox-message-foot"><span>${escapeHtml(message.mailbox)} · ${escapeHtml(formatFolders(message.folders))}</span></div></button>`).join('');
  if (!append) list.innerHTML = markup || empty('暂无邮件'); else list.insertAdjacentHTML('beforeend', markup);
  list.querySelectorAll('[data-inbox-message]').forEach((button) => button.addEventListener('click', () => openInboxMessage(button.dataset.inboxMessage)));
}

async function loadInboxMessages(append = false) {
  const list = document.querySelector('#inbox-message-list');
  if (!list || inbox.loading) return;
  inbox.loading = true;
  if (!append) list.innerHTML = '<div class="empty">正在加载邮件</div>';
  const params = new URLSearchParams({ limit: '40' });
  if (inbox.accountId) params.set('mailAccountId', inbox.accountId);
  const keyword = document.querySelector('#message-search')?.value.trim() || '';
  if (keyword) params.set('keyword', keyword);
  if (document.querySelector('#message-code-only')?.checked) params.set('status', 'code');
  if (append && inbox.cursor) params.set('cursor', inbox.cursor);
  try {
    const data = await api(`/api/admin/messages?${params}`);
    renderInboxMessages(data.messages, append);
    inbox.cursor = data.nextCursor || '';
    inbox.messageHasMore = Boolean(data.nextCursor);
    document.querySelector('#load-more-messages')?.classList.toggle('hidden', !inbox.messageHasMore);
  } finally {
    inbox.loading = false;
  }
}

async function loadInbox() {
  await loadInboxMailboxes(true);
  inbox.cursor = '';
  await loadInboxMessages();
}

async function openInboxMessage(id) {
  inbox.selectedId = id;
  const detail = document.querySelector('#inbox-message-detail');
  detail.innerHTML = '<div class="empty">正在解密邮件正文</div>';
  const data = await api(`/api/admin/messages/${id}`);
  const message = data.message;
  detail.innerHTML = `<header class="inbox-detail-head"><div><span class="card-kicker">MAIL MESSAGE</span><h2>${escapeHtml(message.subject || '无主题')}</h2></div><span class="badge">${escapeHtml(message.mailbox)}</span></header><dl class="inbox-detail-meta"><div><dt>发件人</dt><dd>${escapeHtml(message.sender || '未知')}</dd></div><div><dt>收件人</dt><dd>${escapeHtml(message.recipients || '未知')}</dd></div><div><dt>所在文件夹</dt><dd>${escapeHtml(formatFolders(message.folders))}</dd></div><div><dt>收到时间</dt><dd>${escapeHtml(formatDate(message.receivedAt))}</dd></div></dl><div class="inbox-body-label">邮件信息</div><pre class="inbox-body">${escapeHtml(message.body || '这封邮件没有可显示的邮件信息。')}</pre>`;
}

async function loadState() {
  state.data = await api('/api/admin/state');
  state.csrfToken = state.data.csrfToken;
  render();
}

function openModal(title, body) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal"><header class="modal-head"><h2>${escapeHtml(title)}</h2><button class="btn btn-secondary btn-icon" data-close title="关闭" aria-label="关闭"><i data-lucide="x" class="icon"></i></button></header><div class="modal-body">${body}</div></section></div>`;
  modalRoot.querySelector('[data-close]').addEventListener('click', closeModal);
  lucide.createIcons();
}
function closeModal() { modalRoot.innerHTML = ''; }

function parseAccountImportText(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const columns = line.split(',').map((part) => part.trim());
    if (index === 0 && columns[0]?.toLowerCase() === 'email') return null;
    return { email: columns[0] || '', provider: columns[1] || '', password: columns.slice(2).join(',') };
  }).filter(Boolean);
}

function importStatusLabel(status) {
  const labels = {
    waiting: '等待处理', retry_wait: '等待重试', validating: '正在验证', syncing: '首次同步中',
    completed: '已完成', format_error: '格式错误', duplicate: '重复邮箱',
    login_failed: '登录失败', timeout: '连接超时', failed: '处理失败'
  };
  return labels[status] || status;
}

function renderImportProgress(data) {
  const progress = document.querySelector('#account-import-progress');
  if (!progress) return;
  progress.innerHTML = `<div class="import-summary">
    <div><span>总计</span><strong>${data.total}</strong></div><div><span>等待</span><strong>${data.waiting}</strong></div>
    <div><span>验证中</span><strong>${data.validating}</strong></div><div><span>同步中</span><strong>${data.syncing}</strong></div>
    <div><span>已完成</span><strong>${data.succeeded}</strong></div><div><span>失败</span><strong>${data.failed}</strong></div>
  </div><div class="import-items">${data.items.map((item) => `<div class="import-item"><div><strong>${escapeHtml(item.email || '无效邮箱')}</strong><small>${escapeHtml(item.provider)}</small></div><span class="badge${['completed'].includes(item.status) ? '' : ['format_error', 'duplicate', 'login_failed', 'timeout', 'failed'].includes(item.status) ? ' error' : ' off'}">${escapeHtml(importStatusLabel(item.status))}</span>${item.failureReason ? `<p>${escapeHtml(item.failureReason)}</p>` : ''}</div>`).join('')}</div>
  ${data.retryable ? '<div class="form-actions"><button id="retry-account-import" class="btn btn-secondary" type="button"><i data-lucide="rotate-ccw" class="icon"></i><span>仅重试失败项</span></button></div>' : ''}`;
  const retryButton = document.querySelector('#retry-account-import');
  if (retryButton) retryButton.addEventListener('click', async () => {
    retryButton.disabled = true;
    try {
      await api(`/api/admin/mail-import-jobs/${data.id}/retry`, { method: 'POST' });
      await pollImportJob(data.id);
    } catch (error) {
      document.querySelector('#modal-error').textContent = error.message;
      retryButton.disabled = false;
    }
  });
  lucide.createIcons();
}

async function pollImportJob(jobId) {
  clearTimeout(state.importPollTimer);
  const data = await api(`/api/admin/mail-import-jobs/${jobId}`);
  renderImportProgress(data);
  if (['queued', 'processing'].includes(data.status)) {
    state.importPollTimer = setTimeout(() => pollImportJob(jobId).catch((error) => {
      const box = document.querySelector('#modal-error');
      if (box) box.textContent = error.message;
    }), 3000);
  } else {
    await loadState();
  }
}

function showSecret(token) {
  openModal('查询密钥已生成', `<p>密钥已使用主密钥加密保存。管理员以后可在邮箱列表中通过密码确认再次查看。</p><div id="generated-token" class="secret-box">${escapeHtml(token)}</div><div class="form-actions"><button id="copy-secret" class="btn btn-primary"><i data-lucide="copy" class="icon"></i><span>复制密钥</span></button></div>`);
  document.querySelector('#copy-secret').addEventListener('click', async () => {
    await navigator.clipboard.writeText(token);
    toastMessage('查询密钥已复制');
  });
  lucide.createIcons();
}

function bindRowActions() {
  document.querySelectorAll('[data-account-edit]').forEach((button) => button.addEventListener('click', () => openAccountEditor(button.dataset.accountEdit)));
  document.querySelectorAll('[data-account-secrets]').forEach((button) => button.addEventListener('click', () => openAccountSecrets(button.dataset.accountSecrets)));
  document.querySelectorAll('[data-account-sync]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/mail-account/${button.dataset.accountSync}/sync`, { method: 'POST' });
    await loadState(); toastMessage('已加入下一轮优先同步');
  }));
  document.querySelectorAll('[data-account-toggle]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/mail-account/${button.dataset.accountToggle}/toggle`, { method: 'POST' }); await loadState();
  }));
  document.querySelectorAll('[data-account-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除母邮箱会同时删除其邮箱和验证码记录。确认继续？')) return;
    await api(`/api/admin/mail-account/${button.dataset.accountDelete}`, { method: 'DELETE' }); await loadState();
  }));
  document.querySelectorAll('[data-alias-reset]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('旧查询密钥会立即失效，确认重置？')) return;
    const data = await api(`/api/admin/aliases/${button.dataset.aliasReset}/regenerate`, { method: 'POST' }); await loadState(); showSecret(data.token);
  }));
  document.querySelectorAll('[data-alias-edit]').forEach((button) => button.addEventListener('click', () => openAliasEditor(button.dataset.aliasEdit)));
  document.querySelectorAll('[data-alias-secrets]').forEach((button) => button.addEventListener('click', () => {
    const alias = state.data.aliases.find((row) => String(row.id) === button.dataset.aliasSecrets);
    openAliasSecrets(alias);
  }));
  document.querySelectorAll('[data-totp-secrets]').forEach((button) => button.addEventListener('click', () => openTotpSecrets(button.dataset.totpSecrets)));
  document.querySelectorAll('[data-totp-edit]').forEach((button) => button.addEventListener('click', () => openTotpEditor(button.dataset.totpEdit)));
  document.querySelectorAll('[data-totp-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('确认永久删除这一条 2FA 密钥？')) return;
    await api(`/api/admin/totp-entries/${button.dataset.totpDelete}`, { method: 'DELETE' });
    await loadState();
    toastMessage('2FA 记录已删除');
  }));
  document.querySelectorAll('[data-alias-toggle]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/aliases/${button.dataset.aliasToggle}/toggle`, { method: 'POST' }); await loadState();
  }));
  document.querySelectorAll('[data-alias-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除后，该邮箱的验证码记录也会删除。确认继续？')) return;
    await api(`/api/admin/aliases/${button.dataset.aliasDelete}`, { method: 'DELETE' }); await loadState();
  }));
  document.querySelectorAll('[data-session-revoke]').forEach((button) => button.addEventListener('click', async () => {
    await api(`/api/admin/sessions/${button.dataset.sessionRevoke}`, { method: 'DELETE' });
    await loadState(); toastMessage('该设备已退出');
  }));
}

function openAccountEditor(id) {
  const account = state.data.accounts.find((row) => String(row.id) === String(id));
  if (!account) return;
  const provider = inferMailProvider(account);
  openModal('编辑母邮箱', `<form id="account-edit-form"><div class="form-grid"><div class="field"><label for="edit-account-provider">邮箱服务商</label><select id="edit-account-provider">${mailProviderOptions(provider)}</select></div><div class="field"><label for="edit-account-email">母邮箱地址</label><input id="edit-account-email" type="email" required value="${escapeHtml(account.email)}"></div><div class="field"><label id="edit-account-password-label" for="edit-account-password">授权密码</label><input id="edit-account-password" type="password" autocomplete="new-password" placeholder="留空表示不修改"></div><div class="field"><label for="edit-account-imap">IMAP 服务器</label><input id="edit-account-imap" readonly></div></div><p id="edit-account-help" class="muted compact-note"></p><p class="muted compact-note">保存前会实际测试登录。密码留空时继续使用当前加密凭据；切换服务商时请填写对应的新凭据。</p><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="save" class="icon"></i><span>测试并保存</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#edit-account-provider').addEventListener('change', (event) => {
    updateMailProviderFields('edit-account', { keepPassword: event.currentTarget.value === provider });
  });
  updateMailProviderFields('edit-account', { keepPassword: true });
  document.querySelector('#account-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/admin/mail-account/${id}`, { method: 'PATCH', body: JSON.stringify({
        provider: document.querySelector('#edit-account-provider').value,
        email: document.querySelector('#edit-account-email').value,
        appPassword: document.querySelector('#edit-account-password').value
      }) });
      closeModal(); await loadState(); toastMessage('母邮箱配置已更新');
    } catch (error) {
      document.querySelector('#modal-error').textContent = error.message;
      button.disabled = false;
    }
  });
  lucide.createIcons();
}

function openAccountSecrets(id) {
  const account = state.data.accounts.find((row) => String(row.id) === String(id));
  if (!account) return;
  openModal('查看邮箱凭据', `<p class="muted">请输入当前管理员登录密码，确认查看 ${escapeHtml(account.email)} 的 IMAP 授权密码。</p><form id="account-secrets-form"><div class="field"><label for="account-secrets-password">当前管理员密码</label><input id="account-secrets-password" type="password" autocomplete="current-password" required></div><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="eye" class="icon"></i><span>确认查看</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#account-secrets-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      renderAccountSecrets(await api(`/api/admin/mail-account/${id}/secrets`, { method: 'POST', body: JSON.stringify({ password: document.querySelector('#account-secrets-password').value }) }));
    } catch (error) {
      document.querySelector('#modal-error').textContent = error.message;
      button.disabled = false;
    }
  });
  lucide.createIcons();
}

function renderAccountSecrets(data) {
  const provider = mailProviderDetails[inferMailProvider(data)];
  openModal('邮箱凭据', `<p class="muted">${escapeHtml(provider.label)} · ${escapeHtml(data.email)} · ${escapeHtml(data.host)}:${data.port}。关闭窗口后，页面不会继续保留明文密码。</p>${secretSection(provider.passwordLabel, data.appPassword, 'copy-app-password', '授权密码为空。')}`);
  document.querySelector('#copy-app-password').addEventListener('click', () => navigator.clipboard.writeText(data.appPassword).then(() => toastMessage('邮箱授权密码已复制')));
  lucide.createIcons();
}

function openAliasEditor(id) {
  const alias = state.data.aliases.find((row) => String(row.id) === String(id));
  if (!alias) return;
  const options = state.data.accounts.map((row) => `<option value="${row.id}" ${String(row.id) === String(alias.mail_account_id) ? 'selected' : ''}>${escapeHtml(row.email)}</option>`).join('');
  openModal('编辑邮箱', `<form id="alias-edit-form"><div class="form-grid"><div class="field"><label for="edit-alias-account">所属母邮箱</label><select id="edit-alias-account">${options}</select></div><div class="field"><label for="edit-alias-address">邮箱地址</label><input id="edit-alias-address" type="email" required value="${escapeHtml(alias.address)}"></div><div class="field"><label for="edit-alias-label">备注</label><input id="edit-alias-label" maxlength="80" value="${escapeHtml(alias.label || '')}"></div><div class="field"><label for="edit-alias-expiry">查询密钥有效期</label><select id="edit-alias-expiry"><option value="keep">保持当前设置</option><option value="never">改为长期有效</option><option value="days">从现在起重新计算</option></select></div><div id="edit-alias-days-field" class="field hidden"><label for="edit-alias-days">有效天数</label><input id="edit-alias-days" type="number" min="1" max="3650" value="30"></div></div><p class="muted compact-note">本操作不会修改或重置现有查询密钥。</p><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="save" class="icon"></i><span>保存修改</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#edit-alias-expiry').addEventListener('change', (event) => {
    document.querySelector('#edit-alias-days-field').classList.toggle('hidden', event.target.value !== 'days');
  });
  document.querySelector('#alias-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/aliases/${id}`, { method: 'PATCH', body: JSON.stringify({
        mailAccountId: document.querySelector('#edit-alias-account').value,
        address: document.querySelector('#edit-alias-address').value,
        label: document.querySelector('#edit-alias-label').value,
        expiryMode: document.querySelector('#edit-alias-expiry').value,
        expiresDays: document.querySelector('#edit-alias-days').value
      }) });
      closeModal(); await loadState(); toastMessage('邮箱已更新');
    } catch (error) { document.querySelector('#modal-error').textContent = error.message; }
  });
  lucide.createIcons();
}

function openTotpEditor(id) {
  const entry = state.data.totpEntries.find((row) => String(row.id) === String(id));
  if (!entry) return;
  openModal('编辑 2FA 备注', `<form id="totp-edit-form"><div class="field"><label for="edit-totp-issuer">平台名称</label><input id="edit-totp-issuer" maxlength="120" value="${escapeHtml(entry.issuer || '')}" placeholder="例如 GitHub"></div><div class="field"><label for="edit-totp-account">账号备注</label><input id="edit-totp-account" maxlength="160" value="${escapeHtml(entry.account_name || '')}" placeholder="例如 user@example.com"></div><p class="muted compact-note">这里只修改平台和账号备注，不会修改原始 2FA 密钥。</p><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="save" class="icon"></i><span>保存修改</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#totp-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/totp-entries/${id}`, { method: 'PATCH', body: JSON.stringify({
        issuer: document.querySelector('#edit-totp-issuer').value,
        accountName: document.querySelector('#edit-totp-account').value
      }) });
      closeModal(); await loadState(); toastMessage('2FA 备注已更新');
    } catch (error) { document.querySelector('#modal-error').textContent = error.message; }
  });
  lucide.createIcons();
}

function formatAliasSecrets(rows) {
  return rows.map((row) => `${row.address}--${row.token}`).join('\n');
}

function downloadText(filename, value) {
  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function showImportedAliases(data) {
  openModal('批量导入完成', `<p>成功创建 ${data.created.length} 条，跳过 ${data.skipped.length} 条。</p>${data.created.length ? `<div class="secret-box import-results">${data.created.map((row) => `${escapeHtml(row.address)}--${escapeHtml(row.token)}`).join('\n')}</div><div class="form-actions"><button id="download-import-results" class="btn btn-primary"><i data-lucide="download" class="icon"></i><span>下载新密钥</span></button></div>` : ''}${data.skipped.length ? `<p class="muted compact-note">跳过：${data.skipped.map((row) => `${escapeHtml(row.address || '空值')}（${escapeHtml(row.reason)}）`).join('、')}</p>` : ''}`);
  const button = document.querySelector('#download-import-results');
  if (button) button.addEventListener('click', async () => {
    button.disabled = true;
    downloadText(`icloud-hq-aliases-${new Date().toISOString().slice(0, 10)}.txt`, formatAliasSecrets(data.created));
    try {
      await api('/api/admin/aliases/export/confirm', { method: 'POST', body: JSON.stringify({ aliasIds: data.created.map((row) => row.id) }) });
      toastMessage(`已下载并标记 ${data.created.length} 个邮箱`);
    } catch (error) {
      toastMessage(`文件已下载，但导出状态确认失败：${error.message}`);
      button.disabled = false;
    }
  });
  lucide.createIcons();
}

function secretSection(title, value, copyId, missingText) {
  return `<section class="secret-section"><h3>${escapeHtml(title)}</h3>${value ? `<div class="secret-row"><div class="secret-box">${escapeHtml(value)}</div><button id="${copyId}" class="btn btn-secondary btn-icon" type="button" title="复制${escapeHtml(title)}" aria-label="复制${escapeHtml(title)}"><i data-lucide="copy" class="icon"></i></button></div>` : `<p class="muted">${escapeHtml(missingText)}</p>`}</section>`;
}

function openAliasSecrets(alias) {
  if (!alias) return;
  openModal('查看查询密钥', `<p class="muted">敏感信息不会出现在常规后台数据中。请输入当前管理员登录密码确认查看 ${escapeHtml(alias.address)} 的查询密钥。</p><form id="alias-secrets-form"><div class="field"><label for="alias-secrets-password">当前管理员密码</label><input id="alias-secrets-password" type="password" autocomplete="current-password" required></div><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="eye" class="icon"></i><span>确认查看</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#alias-secrets-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = await api(`/api/admin/aliases/${alias.id}/secrets`, { method: 'POST', body: JSON.stringify({ password: document.querySelector('#alias-secrets-password').value }) });
      renderAliasSecrets(data);
    } catch (error) {
      document.querySelector('#modal-error').textContent = error.message;
      button.disabled = false;
    }
  });
  lucide.createIcons();
}

function renderAliasSecrets(data) {
  const tokenMissing = data.queryTokenRecoverable ? '查询密钥为空。' : '这是升级前创建的旧查询密钥，数据库仅保存不可逆摘要。请重置密钥后再查看。';
  openModal('查询密钥', `<p class="muted">${escapeHtml(data.address)}。关闭窗口后，页面不会继续保留这些明文。</p>${secretSection('查询密钥', data.queryToken, 'copy-query-token', tokenMissing)}`);
  const bindCopy = (selector, value, message) => {
    const button = document.querySelector(selector);
    if (button) button.addEventListener('click', async () => { await navigator.clipboard.writeText(value); toastMessage(message); });
  };
  bindCopy('#copy-query-token', data.queryToken, '查询密钥已复制');
  lucide.createIcons();
}

function openTotpSecrets(id) {
  openModal('查看 2FA 密钥', `<p class="muted">请输入当前管理员登录密码，确认查看这条独立 2FA 的原始密钥和动态验证码。</p><form id="totp-secrets-form"><div class="field"><label for="totp-secrets-password">当前管理员密码</label><input id="totp-secrets-password" type="password" autocomplete="current-password" required></div><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="eye" class="icon"></i><span>确认查看</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#totp-secrets-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      renderTotpSecrets(await api(`/api/admin/totp-entries/${id}/secrets`, { method: 'POST', body: JSON.stringify({ password: document.querySelector('#totp-secrets-password').value }) }));
    } catch (error) {
      document.querySelector('#modal-error').textContent = error.message;
      button.disabled = false;
    }
  });
  lucide.createIcons();
}

function renderTotpSecrets(data) {
  const title = [data.issuer, data.accountName].filter(Boolean).join(' · ') || '独立 2FA';
  openModal(title, `<p class="muted">关闭窗口后，页面不会继续保留这些明文。</p>${secretSection('2FA 手动密钥', data.secret, 'copy-totp-secret', '密钥为空。')}<section class="secret-section"><h3>当前 2FA 验证码</h3><div class="secret-row"><div class="secret-box code-secret">${escapeHtml(data.code)}</div><button id="copy-totp-code-admin" class="btn btn-secondary btn-icon" type="button" title="复制 2FA 验证码" aria-label="复制 2FA 验证码"><i data-lucide="copy" class="icon"></i></button></div><p class="muted compact-note">剩余约 ${data.remaining} 秒。${data.legacyAliasAddress ? ` 此记录由旧邮箱配置 ${escapeHtml(data.legacyAliasAddress)} 自动迁移。` : ''}</p></section>`);
  document.querySelector('#copy-totp-secret').addEventListener('click', () => navigator.clipboard.writeText(data.secret).then(() => toastMessage('2FA 手动密钥已复制')));
  document.querySelector('#copy-totp-code-admin').addEventListener('click', () => navigator.clipboard.writeText(data.code).then(() => toastMessage('2FA 验证码已复制')));
  lucide.createIcons();
}

document.querySelectorAll('.nav button[data-section]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.nav button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.section').forEach((section) => section.classList.toggle('active', section.id === button.dataset.section));
  document.querySelector('#page-title').textContent = button.title;
  if (button.dataset.section === 'messages') loadInbox().catch((error) => toastMessage(error.message));
}));

document.querySelector('#refresh').addEventListener('click', loadState);
document.querySelector('#refresh-inbox')?.addEventListener('click', () => loadInbox().catch((error) => toastMessage(error.message)));
document.querySelector('#load-more-messages')?.addEventListener('click', () => loadInboxMessages(true).catch((error) => toastMessage(error.message)));
document.querySelector('#load-more-mailboxes')?.addEventListener('click', async () => {
  inbox.accountPage += 1;
  await loadInboxMailboxes();
});
document.querySelector('#message-code-only')?.addEventListener('change', () => {
  inbox.cursor = '';
  loadInboxMessages().catch((error) => toastMessage(error.message));
});
['alias-search', 'totp-search'].forEach((id) => {
  document.querySelector(`#${id}`).addEventListener('input', () => state.data && render());
});
document.querySelector('#message-search')?.addEventListener('input', () => {
  clearTimeout(inbox.searchTimer);
  inbox.searchTimer = setTimeout(() => loadInbox().catch(() => {}), 250);
});

async function exportAliases(mode, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/admin/aliases/export?mode=${mode}`);
    if (!data.aliases.length) {
      return toastMessage(data.skipped ? '没有可导出的密钥，请先重置旧密钥' : mode === 'new' ? '没有尚未导出的新增邮箱' : '没有可导出的邮箱密钥');
    }
    const suffix = mode === 'new' ? 'new' : 'all';
    downloadText(`icloud-hq-aliases-${suffix}-${new Date().toISOString().slice(0, 10)}.txt`, formatAliasSecrets(data.aliases));
    if (mode === 'new') {
      await api('/api/admin/aliases/export/confirm', { method: 'POST', body: JSON.stringify({ exportToken: data.exportToken }) });
    }
    toastMessage(data.skipped
      ? `已导出 ${data.aliases.length} 条，跳过 ${data.skipped} 条不可恢复的旧密钥`
      : `已导出 ${data.aliases.length} 条邮箱密钥`);
  } catch (error) {
    toastMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#export-new-aliases').addEventListener('click', (event) => exportAliases('new', event.currentTarget));
document.querySelector('#export-all-aliases').addEventListener('click', (event) => exportAliases('all', event.currentTarget));

document.querySelector('#import-aliases').addEventListener('click', () => {
  if (!state.data.accounts.length) return toastMessage('请先接入母邮箱');
  const options = state.data.accounts.map((row) => `<option value="${row.id}">${escapeHtml(row.email)}</option>`).join('');
  openModal('批量导入邮箱', `<form id="alias-import-form"><div class="field"><label for="import-alias-account">所属母邮箱</label><select id="import-alias-account">${options}</select></div><div class="field"><label for="import-alias-lines">邮箱列表</label><textarea id="import-alias-lines" rows="10" required placeholder="alias1@icloud.com,账号 01&#10;alias2@icloud.com,账号 02"></textarea><div class="field-tools"><small><span id="alias-import-count">0</span> / 100 个邮箱</small></div></div><p class="muted compact-note">每行一个邮箱，可在英文逗号后填写备注，最多导入 100 条。已存在的地址会自动跳过。</p><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="upload" class="icon"></i><span>开始导入</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#import-alias-lines').addEventListener('input', (event) => {
    const count = event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
    document.querySelector('#alias-import-count').textContent = String(count);
    document.querySelector('#alias-import-count').parentElement.classList.toggle('danger-text', count > 100);
  });
  document.querySelector('#alias-import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const aliases = document.querySelector('#import-alias-lines').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [address, ...labelParts] = line.split(',');
      return { address: address.trim(), label: labelParts.join(',').trim() };
    });
    if (aliases.length > 100) return void (document.querySelector('#modal-error').textContent = '每次最多批量导入 100 个邮箱');
    try {
      const data = await api('/api/admin/aliases/import', { method: 'POST', body: JSON.stringify({
        mailAccountId: document.querySelector('#import-alias-account').value,
        aliases
      }) });
      await loadState(); showImportedAliases(data);
    } catch (error) { document.querySelector('#modal-error').textContent = error.message; }
  });
  lucide.createIcons();
});

document.querySelector('#revoke-other-sessions').addEventListener('click', async () => {
  if (!confirm('确认退出除当前浏览器外的所有管理端会话？')) return;
  const data = await api('/api/admin/sessions/revoke-others', { method: 'POST' });
  await loadState(); toastMessage(`已退出 ${data.revoked} 个其他会话`);
});

document.querySelector('#import-accounts').addEventListener('click', () => {
  clearTimeout(state.importPollTimer);
  openModal('批量接入母邮箱', `<form id="account-import-form"><div class="field"><label for="account-import-lines">CSV 账户列表</label><textarea id="account-import-lines" rows="12" required spellcheck="false" placeholder="email,provider,password&#10;account1@icloud.com,icloud,xxxx-xxxx-xxxx-xxxx&#10;account2@gmail.com,gmail,abcdefghijklmnop"></textarea><div class="field-tools"><small><span id="account-import-count">0</span> / 100 个邮箱</small><small>支持 iCloud、Gmail、Outlook，可留空 provider 自动识别</small></div></div><p class="muted compact-note">前端只做格式预检，实际登录验证和最近 7 天首次同步由后台异步执行。凭据加密保存，接口不会再次明文返回。</p><p id="modal-error" class="message"></p><div id="account-import-progress"></div><div id="account-import-actions" class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="upload" class="icon"></i><span>确认导入</span></button></div></form>`);
  const textarea = document.querySelector('#account-import-lines');
  const count = document.querySelector('#account-import-count');
  document.querySelector('[data-cancel]').addEventListener('click', () => {
    clearTimeout(state.importPollTimer);
    closeModal();
  });
  textarea.addEventListener('input', () => {
    const total = parseAccountImportText(textarea.value).length;
    count.textContent = String(total);
    count.parentElement.classList.toggle('danger-text', total > 100);
  });
  document.querySelector('#account-import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const accounts = parseAccountImportText(textarea.value);
    const errorBox = document.querySelector('#modal-error');
    errorBox.textContent = '';
    if (!accounts.length) return void (errorBox.textContent = '请至少填写一个邮箱账户');
    if (accounts.length > 100) return void (errorBox.textContent = '每次最多批量导入 100 个邮箱');
    const invalid = accounts.find((item) => !item.email.includes('@') || item.password.length < 8);
    if (invalid) return void (errorBox.textContent = `请检查 ${invalid.email || '空邮箱'} 的邮箱格式和授权密码`);
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/api/admin/mail-accounts/import', { method: 'POST', body: JSON.stringify({ accounts }) });
      document.querySelector('#account-import-actions').remove();
      textarea.disabled = true;
      await pollImportJob(result.jobId);
    } catch (error) {
      errorBox.textContent = error.message;
      button.disabled = false;
    }
  });
  lucide.createIcons();
});

document.querySelector('#add-account').addEventListener('click', () => {
  openModal('接入母邮箱', `<form id="account-form"><div class="form-grid"><div class="field"><label for="account-provider">邮箱服务商</label><select id="account-provider">${mailProviderOptions()}</select></div><div class="field"><label for="account-email">母邮箱地址</label><input id="account-email" type="email" required placeholder="name@example.com"></div><div class="field"><label id="account-password-label" for="account-password">授权密码</label><input id="account-password" type="password" minlength="8" required autocomplete="new-password"></div><div class="field"><label for="account-imap">IMAP 服务器</label><input id="account-imap" readonly></div></div><p id="account-help" class="muted compact-note"></p><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="plug-zap" class="icon"></i><span>测试并保存</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#account-provider').addEventListener('change', () => updateMailProviderFields('account'));
  updateMailProviderFields('account');
  document.querySelector('#account-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try { await api('/api/admin/mail-account', { method: 'POST', body: JSON.stringify({ provider: document.querySelector('#account-provider').value, email: document.querySelector('#account-email').value, appPassword: document.querySelector('#account-password').value }) }); closeModal(); await loadState(); toastMessage('母邮箱已接入'); }
    catch (error) { document.querySelector('#modal-error').textContent = error.message; button.disabled = false; }
  });
  lucide.createIcons();
});

document.querySelector('#add-alias').addEventListener('click', () => {
  if (!state.data.accounts.length) return toastMessage('请先接入母邮箱');
  const options = state.data.accounts.map((row) => `<option value="${row.id}">${escapeHtml(row.email)}</option>`).join('');
  openModal('添加邮箱', `<form id="alias-form"><div class="form-grid"><div class="field"><label for="alias-account">所属母邮箱</label><select id="alias-account">${options}</select></div><div class="field"><label for="alias-address">邮箱地址</label><input id="alias-address" type="email" required></div><div class="field"><label for="alias-label">备注</label><input id="alias-label" maxlength="80" placeholder="例如：测试账号 01"></div><div class="field"><label for="alias-days">密钥有效天数</label><input id="alias-days" type="number" min="1" max="3650" placeholder="留空表示长期"></div></div><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary" type="submit"><i data-lucide="key-round" class="icon"></i><span>创建并生成密钥</span></button></div></form>`);
  document.querySelector('[data-cancel]').addEventListener('click', closeModal);
  document.querySelector('#alias-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try { const data = await api('/api/admin/aliases', { method: 'POST', body: JSON.stringify({ mailAccountId: document.querySelector('#alias-account').value, address: document.querySelector('#alias-address').value, label: document.querySelector('#alias-label').value, expiresDays: document.querySelector('#alias-days').value || null }) }); closeModal(); await loadState(); showSecret(data.token); }
    catch (error) { document.querySelector('#modal-error').textContent = error.message; button.disabled = false; }
  });
  lucide.createIcons();
});

document.querySelector('#setup-totp').addEventListener('click', async () => {
  const setup = await api('/api/admin/totp/setup', { method: 'POST' });
  openModal('启用 TOTP', `<img class="qr" src="${setup.qrDataUrl}" alt="TOTP 二维码"><p>用身份验证器扫描二维码，然后输入当前六位动态码。</p><div class="secret-box">${escapeHtml(setup.secret)}</div><form id="totp-form"><div class="field"><label for="totp-code">六位动态码</label><input id="totp-code" inputmode="numeric" maxlength="6" required></div><p id="modal-error" class="message"></p><div class="form-actions"><button class="btn btn-primary" type="submit">确认启用</button></div></form>`);
  document.querySelector('#totp-form').addEventListener('submit', async (event) => {
    event.preventDefault(); try { await api('/api/admin/totp/enable', { method: 'POST', body: JSON.stringify({ secret: setup.secret, code: document.querySelector('#totp-code').value }) }); closeModal(); await loadState(); toastMessage('TOTP 已启用'); } catch (error) { document.querySelector('#modal-error').textContent = error.message; }
  });
});

document.querySelector('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ currentPassword: document.querySelector('#current-password').value, newPassword: document.querySelector('#new-password').value }) }); event.currentTarget.reset(); toastMessage('登录密码已更新'); } catch (error) { toastMessage(error.message); }
});

document.querySelector('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.replace('/admin/login'); });

document.querySelectorAll('.mailbox-filter[data-inbox-account]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.mailbox-filter').forEach((item) => item.classList.toggle('active', item === button));
  inbox.accountId = button.dataset.inboxAccount || '';
  inbox.cursor = '';
  loadInboxMessages().catch((error) => toastMessage(error.message));
}));

lucide.createIcons();
loadState().catch((error) => toastMessage(error.message));
setInterval(() => {
  if (!document.hidden && !modalRoot.children.length) loadState().catch(() => {});
}, 15000);
