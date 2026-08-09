'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
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

module.exports = { extractCode, findAlias, normalizeText };
