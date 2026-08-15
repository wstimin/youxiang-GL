'use strict';

const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');
const totpField = document.querySelector('#totp-field');
const loginCopy = document.querySelector('#login-copy');
const submitButton = document.querySelector('#login-submit');
const submitLabel = submitButton.querySelector('span');
const passwordInput = document.querySelector('#password');
const passwordToggle = document.querySelector('#password-toggle');
let challenge = '';

function setSubmitIcon(name) {
  const icon = submitButton.querySelector('svg, [data-lucide]');
  icon.outerHTML = `<i data-lucide="${name}"></i>`;
}

passwordToggle.addEventListener('click', () => {
  const showPassword = passwordInput.type === 'password';
  passwordInput.type = showPassword ? 'text' : 'password';
  passwordToggle.title = showPassword ? '隐藏密码' : '显示密码';
  passwordToggle.setAttribute('aria-label', passwordToggle.title);
  passwordToggle.innerHTML = `<i data-lucide="${showPassword ? 'eye-off' : 'eye'}"></i>`;
  lucide.createIcons();
  passwordInput.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  submitButton.disabled = true;
  submitButton.classList.add('is-loading');
  submitLabel.textContent = challenge ? '正在验证' : '正在登录';
  setSubmitIcon('loader-circle');
  lucide.createIcons();
  try {
    const url = challenge ? '/api/admin/login/totp' : '/api/admin/login';
    const payload = challenge
      ? { challenge, code: document.querySelector('#totp').value }
      : { email: document.querySelector('#email').value, password: document.querySelector('#password').value };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登录失败');
    if (data.requiresTotp) {
      challenge = data.challenge;
      totpField.classList.remove('hidden');
      document.querySelector('#email').disabled = true;
      passwordInput.disabled = true;
      passwordToggle.disabled = true;
      document.querySelector('#totp').required = true;
      loginCopy.textContent = '密码验证成功，请完成动态验证码验证';
      document.querySelector('#totp').focus();
    } else {
      location.replace('/admin');
    }
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove('is-loading');
    submitLabel.textContent = challenge ? '验证并进入' : '安全登录';
    setSubmitIcon(challenge ? 'shield-check' : 'log-in');
    lucide.createIcons();
  }
});

lucide.createIcons();
