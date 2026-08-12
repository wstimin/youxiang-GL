'use strict';

const { compile } = require('html-to-text');

const convertHtml = compile({
  wordwrap: false,
  selectors: [
    { selector: 'head', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'noscript', format: 'skip' },
    { selector: 'template', format: 'skip' },
    { selector: 'svg', format: 'skip' },
    { selector: 'canvas', format: 'skip' },
    { selector: 'iframe', format: 'skip' },
    { selector: 'object', format: 'skip' },
    { selector: 'img', format: 'skip' },
    { selector: 'picture', format: 'skip' },
    { selector: 'video', format: 'skip' },
    { selector: 'audio', format: 'skip' },
    { selector: 'source', format: 'skip' },
    { selector: 'form', format: 'skip' },
    { selector: '[hidden]', format: 'skip' },
    { selector: '[aria-hidden="true"]', format: 'skip' },
    { selector: 'a', format: 'inline' },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } }
  ],
  limits: {
    maxDepth: 60,
    maxChildNodes: 10000,
    maxInputLength: 500000
  }
});

function cleanPlainText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHtml(value) {
  return /<\s*(?:!doctype|html|head|body|title|meta|link|style|script|table|thead|tbody|tr|td|div|p|span|br|a|img|section|article|header|footer|h[1-6]|ul|ol|li)\b/i
    .test(String(value || ''));
}

function htmlToVisibleText(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    return cleanPlainText(convertHtml(source));
  } catch (_error) {
    return cleanPlainText(source
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' '));
  }
}

function extractBodyText(text, html) {
  const textSource = String(text || '').trim();
  if (textSource) {
    return looksLikeHtml(textSource) ? htmlToVisibleText(textSource) : cleanPlainText(textSource);
  }

  return htmlToVisibleText(html);
}

function normalizeText(value) {
  return extractBodyText(value, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCode(subject, text, html) {
  const source = normalizeText(`${subject || ''}\n${text || ''}\n${html || ''}`).slice(0, 200000);
  const token = '((?:\\d[ -]?){4,8}|[A-Z0-9]{4,10})(?![A-Z0-9])';
  const patterns = [
    { confidence: 100, regex: new RegExp(`(?:验证码|校验码|动态码|安全码|verification\\s*code|security\\s*code|one[- ]?time\\s*(?:password|code)|\\botp\\b)(?:\\s*(?:is|为|是))?\\s*[:：#-]?\\s*${token}`, 'ig') },
    { confidence: 90, regex: new RegExp(`${token}[^A-Z0-9]{0,30}(?:是你的验证码|is your verification code|is your security code|is your code)`, 'ig') },
    { confidence: 70, regex: /(?:^|\s)(\d{4,8})(?:\s|$)/g }
  ];

  for (const { confidence, regex } of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const code = match[1].replace(/[ -]/g, '').toUpperCase();
      if (/^(19|20)\d{2}$/.test(code)) continue;
      if (/^\d+$/.test(code) && new Set(code).size === 1) continue;
      if (!/\d/.test(code)) continue;
      return { code, confidence };
    }
  }
  return null;
}

function findAlias(rawHeaders, aliases) {
  const haystack = String(rawHeaders || '').toLowerCase();
  return aliases.find((alias) => {
    const address = String(alias.address || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9.!#$%&'*+/=?^_{|}~-])${address}(?=$|[^a-z0-9.!#$%&'*+/=?^_{|}~-])`, 'i').test(haystack);
  }) || null;
}

module.exports = { extractBodyText, extractCode, findAlias, normalizeText };
