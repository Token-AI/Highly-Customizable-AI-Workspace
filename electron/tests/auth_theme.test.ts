/** @file auth_theme.test.ts
 * @brief 验证主题仅作用于官方 HTTPS 来源，且不包含隐藏或脚本规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auth_theme_css, supports_auth_theme } from '../auth_theme';

test('embedded login theme is limited to official HTTPS origins', () => {
  assert.equal(supports_auth_theme('https://auth.openai.com/log-in'), true);
  assert.equal(supports_auth_theme('https://chatgpt.com/auth/login'), true);
  for (const url of ['https://auth.openai.com.example.org/login', 'https://user:secret@auth.openai.com/',
    'https://auth.openai.com:8443/', 'http://auth.openai.com/', 'https://accounts.google.com/',
    'https://login.microsoftonline.com/', 'http://localhost:1455/auth/callback', 'file:///login.html']) {
    assert.equal(supports_auth_theme(url), false);
  }
  assert.ok(!/display\s*:|visibility\s*:|url\s*\(|@import|content\s*:|pointer-events\s*:/i.test(auth_theme_css));
});
