/**
 * @file backend.test.ts
 * @brief Exercises JSONL transport, subscription state and controller races with a local fixture.
 *
 * Tests spawn only the generated fake server. They never authenticate a real
 * account, inspect credentials, access the network or invoke a model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codex_backend, allowed_login_url, subscription_environment } from '../backend.js';
import type { app_event } from '../../shared/types.js';

/**
 * @brief Local stdio server fixture with deterministic protocol responses and race controls.
 * @note Fake messages preserve the official camelCase wire keys even though fixture symbols use snake_case.
 */
const fixture_source = String.raw`
import readline from 'node:readline';
let authenticated = process.env.FIXTURE_AUTH !== '0';
let model_error = false, interrupt_error = false, turn_number = 0, turn_id = '', current_thread = 'thread-1';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => out({ id, result: value });
const event = (method, params) => out({ method, params });
const finish = (status = 'completed') => event('turn/completed', { threadId: current_thread, turn: { id: turn_id, status } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line), p = request.params || {}, id = request.id;
  if (!request.method && id === 'approval-request') {
    event('item/agentMessage/delta', { threadId: current_thread, turnId: turn_id, itemId: 'approval-result', delta: request.result.decision });
    finish(); continue;
  }
  switch (request.method) {
    case 'initialize':
      if (p.capabilities?.experimentalApi !== true) throw new Error('pagination requires experimental capability');
      result(id, { userAgent: 'fixture' }); break;
    case 'initialized': break;
    case 'account/read': result(id, { account: authenticated ? { type: 'chatgpt', email: process.env.FIXTURE_EMAIL_MISSING === '1' ? null : 'fixture@example.invalid', planType: 'plus' } : null }); break;
    case 'account/login/start':
      setTimeout(() => result(id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize?state=fixture' }), Number(process.env.FIXTURE_LOGIN_DELAY || 0)); break;
    case 'account/login/cancel': result(id, { status: 'canceled' }); break;
    case 'account/logout':
      if (process.env.FIXTURE_LOGOUT_ERROR === '1') setTimeout(() => out({ id, error: { code: -32000, message: 'logout refused' } }), 50);
      else { authenticated = false; result(id, {}); event('account/updated', { authMode: null }); }
      break;
    case 'model/list':
      if (model_error) out({ id, error: { code: -32000, message: 'fixture metadata failure' } });
      else result(id, { data: [{ id: 'fake-model', model: 'fake-model', displayName: 'Fixture Model', isDefault: true, hidden: false }], nextCursor: null });
      break;
    case 'account/rateLimits/read': result(id, { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } }); break;
    case 'thread/list':
      if (!p.sourceKinds?.includes('appServer')) throw new Error('own appServer history must be included');
      result(id, { data: [{ id: 'history-1', name: 'Saved fixture conversation', cwd: process.cwd(), updatedAt: 1 }], nextCursor: null }); break;
    case 'thread/start':
      if (p.sandbox !== 'read-only' && p.sandbox !== 'workspace-write') throw new Error('invalid sandbox');
      if (p.approvalPolicy !== 'untrusted' || p.approvalsReviewer !== 'user') throw new Error('invalid approval policy');
      setTimeout(() => result(id, { thread: { id: 'thread-1', turns: [] } }), Number(process.env.FIXTURE_THREAD_DELAY || 0)); break;
    case 'turn/start': {
      if (p.approvalPolicy !== 'untrusted' || !p.cwd) throw new Error('turn must explicitly retain cwd and approvals');
      if (p.sandboxPolicy?.type !== 'readOnly' && p.sandboxPolicy?.type !== 'workspaceWrite') throw new Error('turn needs an explicit safe sandbox');
      if (p.sandboxPolicy.type === 'workspaceWrite' && (!p.sandboxPolicy.writableRoots?.includes(p.cwd) || p.sandboxPolicy.networkAccess !== false)) throw new Error('write sandbox must name the selected roots');
      current_thread = p.threadId; turn_id = 'turn-' + (++turn_number);
      const own_turn = turn_id, text = p.input[0].text;
      if (text === 'timeout') break;
      if (text === 'late-error') {
        event('turn/started', { threadId: current_thread, turn: { id: own_turn, status: 'inProgress' } });
        finish(); setTimeout(() => out({ id, error: { code: -32000, message: 'late old response' } }), 150); break;
      }
      if (text === 'turn-error') { out({ id, error: { code: -32000, message: 'turn refused' } }); break; }
      result(id, { turn: { id: own_turn, status: 'inProgress' } });
      event('turn/started', { threadId: current_thread, turn: { id: own_turn, status: 'inProgress' } });
      if (text === 'hold') break;
      if (text === 'approval' || text === 'file-approval') {
        if (text === 'file-approval') event('item/started', { threadId: current_thread, turnId: own_turn, item: { type: 'fileChange', id: 'file-item', status: 'inProgress', changes: [{ path: 'sample.cpp', diff: '+ fixture change' }] } });
        out({ id: 'approval-request', method: text === 'approval' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval', params: { threadId: current_thread, turnId: own_turn, itemId: 'file-item', command: 'echo fixture', cwd: process.cwd(), availableDecisions: ['accept', 'decline'] } });
        break;
      }
      const delta = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: current_thread, turnId: own_turn, itemId: 'assistant-' + own_turn, delta: '你好，C++23' } }) + '\n');
      const split = delta.indexOf(Buffer.from('你')) + 1;
      process.stdout.write(delta.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(delta.subarray(split));
        event('item/completed', { threadId: current_thread, turnId: own_turn, item: { id: 'assistant-' + own_turn, type: 'agentMessage', text: '你好，C++23' } });
        finish();
      }, 15);
      break;
    }
    case 'turn/steer': {
      const steered_turn = turn_id;
      if (p.expectedTurnId !== steered_turn || p.threadId !== current_thread) { out({ id, error: { code: -32000, message: 'steering turn mismatch' } }); break; }
      setTimeout(() => p.input[0].text === 'steer-error' ? out({ id, error: { code: -32000, message: 'steering refused' } }) : result(id, { turnId: steered_turn }), Number(process.env.FIXTURE_STEER_DELAY || 0));
      break;
    }
    case 'turn/interrupt': {
      if (interrupt_error) { interrupt_error = false; out({ id, error: { code: -32000, message: 'interrupt temporarily refused' } }); }
      else {
        const interrupted_thread = current_thread, interrupted_turn = turn_id;
        result(id, {});
        const ended = () => event('turn/completed', { threadId: interrupted_thread, turn: { id: interrupted_turn, status: 'interrupted' } });
        const delay = Number(process.env.FIXTURE_INTERRUPT_DELAY || 0);
        if (delay) setTimeout(ended, delay); else ended();
      }
      break;
    }
    case 'thread/resume':
      current_thread = p.threadId;
      if (!p.excludeTurns) throw new Error('History must be paginated');
      result(id, { thread: { id: p.threadId, turns: [] }, cwd: p.cwd, model: 'fake-model' }); break;
    case 'thread/turns/list': result(id, { data: [{ id: 'saved-turn', status: 'completed', items: [] }], nextCursor: null }); break;
    case 'thread/items/list':
      if (process.env.FIXTURE_PAGINATION_ERROR === '1') { out({ id, error: { code: -32601, message: 'item pagination unsupported by active store' } }); break; }
      result(id, { data: [
      { turnId: 'saved-turn', item: { id: 'saved-assistant', type: 'agentMessage', text: 'Saved answer' } },
      { turnId: 'saved-turn', item: { id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: 'Saved question' }] } }
    ], nextCursor: null }); break;
    case 'thread/read': result(id, { thread: { id: current_thread, turns: [{ id: 'saved-turn', status: 'completed', items: [
      { id: 'saved-user', type: 'userMessage', content: [{ type: 'text', text: 'Saved question' }] },
      { id: 'saved-assistant', type: 'agentMessage', text: 'Saved answer' }
    ] }] } }); break;
    case 'fixture/modelError': model_error = true; break;
    case 'fixture/interruptError': interrupt_error = true; break;
    case 'fixture/loginComplete': authenticated = true; event('account/login/completed', { loginId: 'login-1', success: true }); break;
    case 'fixture/complete': finish(p.status || 'completed'); break;
    case 'fixture/event': out(p); break;
    case 'fixture/oversized': process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); break;
    default: if (id !== undefined) out({ id, error: { code: -32601, message: 'unknown fixture method' } });
  }
}
`;

/**
 * @brief Waits for an observable asynchronous fixture condition within a bounded deadline.
 * @param predicate Condition rechecked after short event-loop yields.
 * @param message Assertion description reported when the condition never becomes true.
 * @param timeout Maximum wait in milliseconds.
 * @returns When the predicate first succeeds.
 * @throws AssertionError If the deadline expires before the condition is satisfied.
 */
async function wait_for(predicate: () => boolean, message: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

/**
 * @brief Creates an isolated fake-server controller and registers process-aware cleanup.
 * @param t Node test context receiving the teardown callback.
 * @param settings Fixture-only environment switches controlling responses and timing.
 * @param request_timeout_ms RPC deadline used by this test controller.
 * @param project_selected Whether the controller starts with an explicitly selected project.
 * @returns Controller, captured events and helpers for injecting fixture notifications.
 * @throws Error If fixture filesystem setup or process configuration validation fails.
 */
async function harness(t: { after: (callback: () => Promise<void>) => void }, settings: Record<string, string> = {}, request_timeout_ms = 3000, project_selected = true) {
  const temporary_root = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporary_root, 'ai-code backend fixture '));
  const fixture = path.join(directory, 'fake server Unicode 测试.mjs');
  const codex_home = path.join(directory, 'isolated-home');
  await writeFile(fixture, fixture_source, 'utf8');
  const events: app_event[] = [], requests: { method: string; params?: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined, closed_login = 0;
  const backend = new codex_backend({
    cwd: project_selected ? directory : '', home: codex_home, executable: process.execPath,
    env: { ...process.env, ...settings, oPeNaI_aPi_KeY: 'fabricated-never-used', CODEX_API_KEY: 'fabricated-never-used', OPENAI_BASE_URL: 'https://example.invalid', FIXTURE_PRESERVED: 'yes' },
    request_timeout_ms, close_timeout_ms: 1000,
    emit: event => events.push(event), open_login: async url => { opened.push(url); }, close_login: () => { closed_login++; },
    spawn: (_file, args, options) => {
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.equal(options.env?.CODEX_HOME, path.join(directory, 'isolated-home'));
      assert.equal(options.env?.FIXTURE_PRESERVED, 'yes');
      for (const key of Object.keys(options.env ?? {})) assert.ok(!['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'].includes(key.toUpperCase()));
      child = spawn(process.execPath, [fixture], { ...options, stdio: 'pipe' });
      const original = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        for (const line of text.split('\n').filter(Boolean)) {
          const value = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
          if (value.method) requests.push({ method: value.method, params: value.params });
        }
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof child.stdin.write;
      return child;
    },
  });
  t.after(async () => {
    await backend.dispose();
    assert.equal(path.dirname(directory), temporary_root);
    assert.ok(path.basename(directory).startsWith('ai-code backend fixture '));
    await rm(directory, { recursive: true, force: true });
  });
  const inject = (method: string, params: Record<string, unknown> = {}) => child!.stdin.write(JSON.stringify({ method, params }) + '\n');
  return { backend, directory, codex_home, events, requests, opened, inject, child: () => child!, closed_login: () => closed_login };
}

test('subscription environment and login URL policy are narrow and preserve unrelated settings', () => {
  assert.deepEqual(subscription_environment({ Path: 'tools', HTTPS_PROXY: 'proxy', codex_home: 'old', OPENAI_API_KEY: 'fake', codex_api_key: 'fake', OpenAI_Base_URL: 'fake' }, 'isolated'),
    { Path: 'tools', HTTPS_PROXY: 'proxy', CODEX_HOME: 'isolated' });
  assert.ok(allowed_login_url('https://auth.openai.com/authorize?state=fixture'));
  assert.ok(allowed_login_url('https://chatgpt.com/auth'));
  for (const url of ['http://auth.openai.com/', 'https://auth.openai.com.evil.invalid/', 'https://user:pass@auth.openai.com/', 'file:///x', 'https://auth.openai.com:9000/']) assert.equal(allowed_login_url(url), false);
});

test('real child JSONL framing preserves split UTF-8, models, account and quota', async t => {
  const h = await harness(t); await h.backend.connect();
  assert.equal(h.backend.state.connected, true); assert.equal(h.backend.state.authenticated, true);
  assert.equal(h.backend.state.model, 'fake-model'); assert.match(h.backend.state.quota, /75%/);
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'turn did not complete');
  assert.equal(h.backend.state.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(h.backend.state.messages.find(message => message.role === 'assistant')?.text, '你好，C++23');
  assert.equal(h.opened.length, 0);
});

test('metadata failures never make an active turn idle, and stale turn events are ignored', async t => {
  const h = await harness(t); await h.backend.connect();
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'first turn did not complete');
  await h.backend.send('hold'); assert.equal(h.backend.state.busy, true);
  h.inject('fixture/modelError'); await h.backend.refresh();
  assert.equal(h.backend.state.busy, true); assert.match(h.backend.state.error, /metadata failure/);
  h.inject('fixture/event', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(h.backend.state.busy, true);
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'stop did not finish');
  assert.equal(h.backend.state.status, '已停止生成');
});

test('stop before thread/start responds never submits a model turn', async t => {
  const h = await harness(t, { FIXTURE_THREAD_DELAY: '100' }); await h.backend.connect();
  const sending = h.backend.send('hold'); await h.backend.stop(); await sending;
  assert.equal(h.backend.state.busy, false); assert.equal(h.backend.state.stopping, false);
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 0);
  assert.equal(h.backend.state.messages.length, 0);
});

test('explicit turn rejection rejects the send promise and removes its unsubmitted message', async t => {
  const h = await harness(t); await h.backend.connect();
  await assert.rejects(h.backend.send('turn-error'), /turn refused/);
  assert.equal(h.backend.state.busy, false);
  assert.equal(h.backend.state.messages.length, 0);
  assert.match(h.backend.state.error, /turn refused/);
});

test('rejected interrupt keeps the turn active and permits a second stop attempt', async t => {
  const h = await harness(t); await h.backend.connect(); await h.backend.send('hold');
  h.inject('fixture/interruptError'); await h.backend.stop();
  assert.equal(h.backend.state.busy, true); assert.equal(h.backend.state.stopping, false);
  assert.match(h.backend.state.error, /interrupt temporarily refused/);
  await assert.rejects(h.backend.send('must not overlap'), /当前操作/);
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'retry did not stop turn');
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal(h.requests.filter(request => request.method === 'turn/interrupt').length, 2);
});

test('command and file approvals require an explicit decision', async t => {
  const h = await harness(t); await h.backend.connect();
  await h.backend.send('approval');
  await wait_for(() => h.events.some(event => event.type === 'approval'), 'approval was not surfaced');
  assert.equal(h.backend.state.busy, true);
  const first = h.events.find(event => event.type === 'approval'); assert.ok(first?.type === 'approval');
  assert.match(first.approval.detail, /echo fixture/);
  await h.backend.approve(first.approval.id, false); await wait_for(() => !h.backend.state.busy, 'decline did not finish');
  assert.equal(h.backend.state.messages.find(message => message.id === 'approval-result')?.text, 'decline');
  await h.backend.send('file-approval');
  await wait_for(() => h.events.filter(event => event.type === 'approval').length === 2, 'file approval was not surfaced');
  const second = h.events.filter(event => event.type === 'approval').at(-1); assert.ok(second?.type === 'approval');
  assert.match(second.approval.detail, /sample\.cpp/); assert.match(h.backend.state.diff, /fixture change/);
  await h.backend.approve(second.approval.id, true); await wait_for(() => !h.backend.state.busy, 'approval did not finish');
});

test('cancel while login/start is pending never opens the auth window', async t => {
  const h = await harness(t, { FIXTURE_AUTH: '0', FIXTURE_LOGIN_DELAY: '100' }); await h.backend.connect();
  const login = h.backend.login(); await h.backend.cancel_login(); await login;
  assert.equal(h.backend.state.login_pending, false); assert.equal(h.opened.length, 0);
  assert.equal(h.requests.filter(request => request.method === 'account/login/cancel').length, 1);
  assert.ok(h.closed_login() > 0);
});

test('completed app-owned login refreshes account, and logout stays isolated', async t => {
  const h = await harness(t, { FIXTURE_AUTH: '0' }); await h.backend.connect();
  await h.backend.login(); assert.equal(h.opened.length, 1);
  h.inject('fixture/loginComplete'); await wait_for(() => h.backend.state.authenticated && !!h.backend.state.model, 'login completion was not hydrated');
  assert.equal(h.backend.state.login_pending, false); assert.ok(h.closed_login() > 0);
  await h.backend.logout(); assert.equal(h.backend.state.authenticated, false); assert.equal(h.backend.state.thread_id, '');
});

test('account email remains separate from plan metadata and clears at account boundaries', async t => {
  const h = await harness(t); await h.backend.connect();
  assert.equal(h.backend.state.account_email, 'fixture@example.invalid');
  assert.match(h.backend.state.account, /plus/);
  const reconnecting = h.backend.connect();
  assert.equal(h.backend.state.account_email, undefined);
  await reconnecting; assert.equal(h.backend.state.account_email, 'fixture@example.invalid');
  await h.backend.logout(); assert.equal(h.backend.state.account_email, undefined);
  const without_email = await harness(t, { FIXTURE_EMAIL_MISSING: '1' }); await without_email.backend.connect();
  assert.equal(without_email.backend.state.authenticated, true);
  assert.equal(without_email.backend.state.account_email, undefined);
  await h.backend.connect(); assert.equal(h.backend.state.account_email, 'fixture@example.invalid');
  h.inject('fixture/oversized'); await wait_for(() => !h.backend.state.connected, 'disconnect did not clear account identity');
  assert.equal(h.backend.state.account_email, undefined);
});

test('rejected logout preserves the account and blocks turns while the request is pending', async t => {
  const h = await harness(t, { FIXTURE_LOGOUT_ERROR: '1' }); await h.backend.connect();
  const logout = h.backend.logout();
  assert.equal(h.backend.state.authenticated, true);
  await assert.rejects(h.backend.send('must not race logout'), /当前操作/);
  await logout;
  assert.equal(h.backend.state.authenticated, true);
  assert.match(h.backend.state.error, /logout refused/);
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 0);
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'account did not recover after rejected logout');
});

test('history uses paginated wrapped items in chronological order', async t => {
  const h = await harness(t); await h.backend.connect(); await h.backend.resume('history-1');
  assert.equal(h.backend.state.thread_id, 'history-1'); assert.equal(h.backend.state.session_loading, false);
  assert.deepEqual(h.backend.state.messages.map(message => [message.role, message.text]), [['user', 'Saved question'], ['assistant', 'Saved answer']]);
  assert.equal(h.requests.find(request => request.method === 'thread/resume')?.params?.excludeTurns, true);
});

test('history falls back to stable thread/read when the active store cannot paginate', async t => {
  const h = await harness(t, { FIXTURE_PAGINATION_ERROR: '1' }); await h.backend.connect(); await h.backend.resume('history-1');
  assert.equal(h.backend.state.thread_id, 'history-1'); assert.equal(h.backend.state.session_loading, false);
  assert.deepEqual(h.backend.state.messages.map(message => [message.role, message.text]), [['user', 'Saved question'], ['assistant', 'Saved answer']]);
  assert.equal(h.requests.find(request => request.method === 'thread/read')?.params?.includeTurns, true);
});

test('new chat and reconnect reset snake_case state and connection-owned turn IDs', async t => {
  const h = await harness(t); await h.backend.connect();
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'original connection turn did not complete');
  await h.backend.resume('history-1');
  h.backend.new_chat();
  assert.equal(h.backend.state.thread_id, ''); assert.equal(h.backend.state.messages.length, 0);
  await h.backend.resume('history-1'); await h.backend.connect();
  assert.equal(h.backend.state.thread_id, ''); assert.equal(h.backend.state.messages.length, 0);
  for (const name of ['threadId', 'loginPending', 'sessionLoading']) assert.equal(Object.hasOwn(h.backend.state, name), false);
  /// A restarted fixture reuses turn-1; only the new connection may own that ID.
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'new connection reused turn ID was incorrectly filtered');
  assert.equal(h.backend.state.messages.find(message => message.role === 'assistant')?.text, '你好，C++23');
});

test('no-project chats use only the isolated runtime directory and retain an empty UI project', async t => {
  const h = await harness(t, {}, 3000, false);
  const internal_cwd = path.join(h.codex_home, 'empty_workspace');
  assert.equal(h.backend.state.cwd, '');
  await assert.rejects(h.backend.set_project(''), /有效的绝对目录/); assert.equal(h.backend.state.cwd, '');
  assert.throws(() => h.backend.set_mode('workspace-write'), /先选择项目/);
  assert.equal(h.backend.state.mode, 'read-only');
  await h.backend.connect(); assert.equal(h.backend.state.connected, true);
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'no-project chat did not complete');
  const started = h.requests.find(request => request.method === 'thread/start');
  assert.equal(started?.params?.cwd, internal_cwd); assert.equal(started?.params?.sandbox, 'read-only');
  assert.match(String(started?.params?.developerInstructions), /No project is selected/);
  assert.equal(h.backend.state.cwd, '');
  h.backend.new_chat(); await h.backend.connect(); assert.equal(h.backend.state.cwd, '');
  await h.backend.set_project(h.directory); h.backend.set_mode('workspace-write');
  assert.equal(h.backend.state.cwd, h.directory); assert.equal(h.backend.state.mode, 'workspace-write');
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'explicit project chat did not complete');
  const selected = h.requests.findLast(request => request.method === 'thread/start');
  assert.equal(selected?.params?.cwd, h.directory); assert.equal(selected?.params?.sandbox, 'workspace-write');
  await h.backend.resume('history-1');
  assert.equal(h.backend.state.cwd, ''); assert.equal(h.backend.state.mode, 'read-only');
  const resumed = h.requests.findLast(request => request.method === 'thread/resume');
  assert.equal(resumed?.params?.cwd, internal_cwd); assert.equal(resumed?.params?.sandbox, 'read-only');
  for (const event of h.events) if (event.type === 'state') assert.notEqual(event.state.cwd, internal_cwd);
});

test('a late failed turn/start response cannot clear the next turn busy state', async t => {
  const h = await harness(t); await h.backend.connect();
  const first = h.backend.send('late-error'); await wait_for(() => !h.backend.state.busy, 'first turn did not complete');
  await h.backend.send('hold'); await first;
  assert.equal(h.backend.state.busy, true);
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'second turn did not stop');
});

test('multi-directory turns keep every selected root, isolate history changes and allow project exit', async t => {
  const h = await harness(t); await h.backend.connect();
  const secondary = path.join(h.directory, 'secondary root 测试'), unrelated = path.join(h.directory, 'another project');
  await mkdir(secondary); await mkdir(unrelated);
  const primary_root = await realpath(h.directory), secondary_root = await realpath(secondary);
  await h.backend.set_directories([h.directory, secondary, h.directory, secondary]);
  assert.equal(h.backend.state.cwd, primary_root);
  assert.deepEqual(h.backend.state.workspace_roots, [primary_root, secondary_root]);
  h.backend.set_mode('workspace-write'); await h.backend.send('echo');
  await wait_for(() => !h.backend.state.busy, 'multi-root turn did not complete');
  const first_turn = h.requests.findLast(request => request.method === 'turn/start');
  assert.deepEqual(first_turn?.params?.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [primary_root, secondary_root], networkAccess: false });
  assert.ok(String(h.requests.findLast(request => request.method === 'thread/start')?.params?.developerInstructions).includes(JSON.stringify(secondary_root)));
  await h.backend.resume('history-1', [primary_root, secondary_root]);
  assert.deepEqual(h.backend.state.workspace_roots, [primary_root, secondary_root]);
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'restored multi-root turn did not complete');
  assert.deepEqual(h.requests.findLast(request => request.method === 'turn/start')?.params?.sandboxPolicy,
    { type: 'workspaceWrite', writableRoots: [primary_root, secondary_root], networkAccess: false });
  await h.backend.set_directories([unrelated, secondary]); await h.backend.resume('history-1', [unrelated, secondary]);
  assert.equal(h.backend.state.cwd, await realpath(unrelated));
  assert.deepEqual(h.backend.state.workspace_roots, [await realpath(unrelated), secondary_root]);
  assert.equal(h.requests.findLast(request => request.method === 'thread/resume')?.params?.cwd, await realpath(unrelated));
  await h.backend.resume('history-1');
  assert.deepEqual(h.backend.state.workspace_roots, [primary_root]);
  assert.ok(!String(h.requests.findLast(request => request.method === 'thread/resume')?.params?.developerInstructions).includes(JSON.stringify(secondary_root)));
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'single-root history turn did not complete');
  assert.deepEqual(h.requests.findLast(request => request.method === 'turn/start')?.params?.sandboxPolicy,
    { type: 'workspaceWrite', writableRoots: [primary_root], networkAccess: false });
  await h.backend.set_directories([]);
  assert.equal(h.backend.state.cwd, ''); assert.equal(h.backend.state.workspace_roots?.length, 0);
  assert.equal(h.backend.state.mode, 'read-only'); assert.equal(h.backend.state.thread_id, '');
  assert.equal(h.backend.state.messages.length, 0);
  await h.backend.send('echo'); await wait_for(() => !h.backend.state.busy, 'projectless turn after exit did not complete');
  const projectless = h.requests.findLast(request => request.method === 'turn/start');
  assert.equal(projectless?.params?.cwd, path.join(h.codex_home, 'empty_workspace'));
  assert.deepEqual(projectless?.params?.sandboxPolicy, { type: 'readOnly' });
  await h.backend.resume('history-1', []);
  assert.equal(h.backend.state.cwd, ''); assert.equal(h.backend.state.workspace_roots?.length, 0);
});

test('directory selection rejects invalid or conflicting changes without partially changing roots', async t => {
  const h = await harness(t); await h.backend.connect();
  const primary = await realpath(h.directory), secondary = path.join(h.directory, 'real secondary'), linked = path.join(h.directory, 'linked secondary');
  await mkdir(secondary); await symlink(secondary, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const invalid = [
    ['relative-folder'], [h.directory, path.join(h.directory, 'missing')], [h.directory, linked],
    [path.join(h.codex_home, 'empty_workspace')], Array.from({ length: 17 }, () => h.directory),
  ];
  for (const directories of invalid) {
    await assert.rejects(h.backend.set_directories(directories));
    assert.equal(h.backend.state.cwd, primary); assert.deepEqual(h.backend.state.workspace_roots, [primary]);
  }
  await h.backend.send('hold'); await assert.rejects(h.backend.set_directories([]), /当前操作/);
  assert.equal(h.backend.state.cwd, primary); assert.equal(h.backend.state.busy, true);
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'held turn did not stop');
  const superseded = h.backend.set_directories([secondary]);
  await h.backend.set_directories([]);
  await assert.rejects(superseded, /取代/);
  assert.equal(h.backend.state.cwd, ''); assert.equal(h.backend.state.workspace_roots?.length, 0);
});

test('queued messages run FIFO only after success and wait for explicit resume after a failed turn', async t => {
  const h = await harness(t); await h.backend.connect(); await h.backend.send('hold');
  await h.backend.enqueue('first queued'); await h.backend.enqueue('second queued');
  assert.equal(h.backend.state.queued_messages?.length, 2);
  h.inject('fixture/complete');
  await wait_for(() => !h.backend.state.busy && h.backend.state.queued_messages?.length === 0, 'FIFO did not drain');
  const submitted = () => h.requests.filter(request => request.method === 'turn/start').map(request =>
    ((request.params?.input as { text: string }[])[0]).text);
  assert.deepEqual(submitted(), ['hold', 'first queued', 'second queued']);
  await h.backend.send('hold'); await h.backend.enqueue('after failure');
  h.inject('fixture/complete', { status: 'failed' });
  await wait_for(() => !h.backend.state.busy, 'failed turn remained busy');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(submitted().length, 4); assert.equal(h.backend.state.queued_messages?.length, 1);
  await h.backend.resume_queue();
  await wait_for(() => !h.backend.state.busy && h.backend.state.queued_messages?.length === 0, 'explicit queue resume failed');
  assert.equal(submitted().at(-1), 'after failure');
});

test('queued submission rejection preserves text and a later context change prevents stale reinsertion', async t => {
  const h = await harness(t); await h.backend.connect();
  await h.backend.enqueue('turn-error');
  await wait_for(() => !h.backend.state.busy && h.backend.state.queued_messages?.length === 1, 'refused queue entry was lost');
  const retained = h.backend.state.queued_messages?.[0]; assert.ok(retained);
  assert.equal(retained.text, 'turn-error');
  await assert.rejects(h.backend.resume_queue(), /turn refused/);
  assert.equal(h.backend.state.queued_messages?.[0]?.id, retained.id);
  h.backend.remove_queued(retained.id); assert.equal(h.backend.state.queued_messages?.length, 0);
  await h.backend.enqueue('late-error');
  await wait_for(() => !h.backend.state.busy, 'late-response fixture did not reach a terminal turn');
  h.backend.new_chat();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(h.backend.state.queued_messages?.length, 0); assert.equal(h.backend.state.messages.length, 0);
  await h.backend.send('hold'); await h.backend.enqueue('old project message');
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'stop did not finish before project change');
  assert.equal(h.backend.state.queued_messages?.length, 1);
  await h.backend.set_directories([]);
  assert.equal(h.backend.state.queued_messages?.length, 0);
});

test('steering targets the active turn and rejection leaves the turn busy without retaining unsent text', async t => {
  const h = await harness(t); await h.backend.connect(); await h.backend.send('hold');
  await h.backend.steer('focus on the parser');
  const steered = h.requests.findLast(request => request.method === 'turn/steer');
  assert.equal(steered?.params?.threadId, 'thread-1'); assert.equal(steered?.params?.expectedTurnId, 'turn-1');
  assert.equal(h.backend.state.messages.at(-1)?.text, 'focus on the parser');
  await assert.rejects(h.backend.steer('steer-error'), /steering refused/);
  assert.equal(h.backend.state.busy, true);
  assert.ok(!h.backend.state.messages.some(message => message.text === 'steer-error'));
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 1);
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'steered turn did not stop');
});

test('a late steering acknowledgment never appends a message to a newer conversation', async t => {
  const h = await harness(t, { FIXTURE_STEER_DELAY: '120' }); await h.backend.connect(); await h.backend.send('hold');
  const steering = h.backend.steer('old conversation guidance');
  h.inject('fixture/complete'); await wait_for(() => !h.backend.state.busy, 'original turn did not complete');
  h.backend.new_chat(); await h.backend.send('hold'); await steering;
  assert.equal(h.backend.state.busy, true);
  assert.ok(!h.backend.state.messages.some(message => message.text === 'old conversation guidance'));
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'new conversation turn did not stop');
});

test('stop-and-send waits beyond interrupt acknowledgment and leaves the previous FIFO paused', async t => {
  const h = await harness(t, { FIXTURE_INTERRUPT_DELAY: '120' }); await h.backend.connect(); await h.backend.send('hold');
  await h.backend.enqueue('keep queued');
  const replacing = h.backend.stop_and_send('replacement');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal(h.backend.state.busy, true);
  await replacing; await wait_for(() => !h.backend.state.busy, 'replacement turn did not complete');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 2);
  assert.equal(h.backend.state.queued_messages?.[0]?.text, 'keep queued');
  const queued = h.backend.state.queued_messages?.[0]; assert.ok(queued);
  h.backend.remove_queued(queued.id);
});

test('stop-and-send rejection preserves the active turn and does not submit replacement text', async t => {
  const h = await harness(t); await h.backend.connect(); await h.backend.send('hold');
  h.inject('fixture/interruptError');
  await assert.rejects(h.backend.stop_and_send('must retain draft'), /interrupt temporarily refused/);
  assert.equal(h.backend.state.busy, true); assert.equal(h.backend.state.stopping, false);
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.ok(!h.backend.state.messages.some(message => message.text === 'must retain draft'));
  await h.backend.stop(); await wait_for(() => !h.backend.state.busy, 'retry stop did not complete');
});

test('stop-and-send before thread creation finishes submits only the replacement', async t => {
  const h = await harness(t, { FIXTURE_THREAD_DELAY: '100' }); await h.backend.connect();
  const sending = h.backend.send('hold');
  const replacing = h.backend.stop_and_send('replacement before start');
  await Promise.all([sending, replacing]); await wait_for(() => !h.backend.state.busy, 'early replacement did not complete');
  assert.equal(h.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.ok(!h.backend.state.messages.some(message => message.text === 'hold'));
  assert.ok(h.backend.state.messages.some(message => message.text === 'replacement before start'));
});

test('uncertain mutating timeout disconnects instead of allowing duplicate turns', async t => {
  const h = await harness(t, {}, 1000); await h.backend.connect();
  assert.equal(h.backend.state.authenticated, true);
  await h.backend.send('timeout');
  assert.equal(h.backend.state.connected, false); assert.equal(h.backend.state.busy, false);
  assert.match(h.backend.state.error, /超时/);
});

test('oversized frames disconnect and dispose stops emitting state events', async t => {
  const h = await harness(t, { FIXTURE_AUTH: '0' }); await h.backend.connect(); await h.backend.login();
  assert.equal(h.backend.state.login_pending, true); h.inject('fixture/oversized');
  await wait_for(() => !h.backend.state.connected, 'oversized frame was not rejected');
  assert.match(h.backend.state.error, /8 MiB/);
  assert.equal(h.backend.state.login_pending, false); assert.equal(h.backend.state.session_loading, false);
  await h.backend.dispose(); const count = h.events.length;
  assert.ok(h.child().exitCode !== null || h.child().signalCode !== null, 'dispose returned before the detached child exited');
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(h.events.length, count);
});
