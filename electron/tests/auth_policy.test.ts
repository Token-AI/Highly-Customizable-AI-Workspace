/**
 * @file auth_policy.test.ts
 * @brief 验证官方入口、HTTPS 身份提供方和精确 loopback 回调边界。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { create_auth_policy } from '../auth_policy';

const initial = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=expected';

/** @brief 非官方、降级协议、异常端口或携带 userinfo 的入口必须被拒绝。 */
test('only official HTTPS URLs can begin login', () => {
  for (const url of ['http://auth.openai.com/x', 'https://auth.openai.com:4443/x', 'https://auth.openai.com.evil.test/x', 'https://user:password@auth.openai.com/x', 'file:///tmp/auth', 'javascript:alert(1)']) {
    assert.throws(() => create_auth_policy(url));
  }
  assert.equal(create_auth_policy(initial).evaluate(initial).allowed, true);
});

/** @brief HTTPS 身份提供方可继续登录，展示结果不得包含查询参数。 */
test('HTTPS identity providers stay inside the secure login flow', () => {
  const policy = create_auth_policy(initial);
  assert.deepEqual(policy.evaluate('https://accounts.google.com/signin?secret=hidden'), { allowed: true, origin: 'https://accounts.google.com' });
  assert.equal(policy.evaluate('https://enterprise.example.org/sso').allowed, true);
  for (const url of ['http://accounts.google.com', 'file:///C:/secret', 'javascript:alert(1)', 'vscode://anything', 'data:text/html,hello']) {
    assert.equal(policy.evaluate(url).allowed, false);
  }
});

/** @brief 回调主机、端口、路径、state 或参数唯一性不匹配时必须拒绝。 */
test('loopback callback is bound to declared host, port, path and state', () => {
  const policy = create_auth_policy(initial);
  assert.equal(policy.evaluate('http://localhost:1455/auth/callback?code=opaque&state=expected').allowed, true);
  for (const url of ['http://localhost:1456/auth/callback?state=expected', 'http://127.0.0.1:1455/auth/callback?state=expected',
    'http://localhost:1455/other?state=expected', 'http://localhost:1455/auth/callback?state=wrong',
    'https://localhost:1455/auth/callback?state=expected', 'https://127.0.0.2/private', 'https://localhost./private',
    'https://[::ffff:127.0.0.1]/private', 'http://localhost:1455/auth/callback?state=expected&state=other']) assert.equal(policy.evaluate(url).allowed, false);
  assert.equal(create_auth_policy('https://chatgpt.com/auth/login').evaluate('http://localhost:1455/auth/callback').allowed, false);
});
