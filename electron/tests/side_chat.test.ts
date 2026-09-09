/** @file side_chat.test.ts
 * @brief 用内存 IPC 通道验证侧边对话交接、超时竞态和窗口数量，不启动真实进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Serializable, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { side_chat_launcher, validate_side_chat_bootstrap, wait_for_side_chat_bootstrap, type side_chat_child } from '../side_chat';

/** @brief 在微任务中交付消息的假 IPC 端点，同时提供假的进程生命周期。 */
class fake_channel extends EventEmitter implements side_chat_child {
  connected = true;
  peer: fake_channel | undefined;
  sent: Serializable[] = [];
  killed = false;
  unreferenced = false;
  lose_commit = false;

  /** @brief 发送内存消息；丢失提交模式用来验证草稿接管后的安全退路。@param message 协议数据。@param callback 排队结果。@returns 通道当前是否连接。 */
  send(message: Serializable, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => {
      if (!this.connected || !this.peer?.connected) { callback?.(new Error('fake channel closed')); return; }
      if (this.lose_commit && typeof message === 'object' && message !== null && 'type' in message && message.type === 'commit') {
        callback?.(new Error('fake commit was not delivered')); return;
      }
      this.peer.emit('message', message);
      callback?.(null);
    });
    return this.connected;
  }

  /** @brief 关闭双方通道，不触发进程退出。 */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    if (this.peer) this.peer.connected = false;
    queueMicrotask(() => { this.emit('disconnect'); this.peer?.emit('disconnect'); });
  }
  /** @brief 记录解除父进程引用的操作，不启动或结束任何进程。 */
  unref(): void { this.unreferenced = true; }
  /** @brief 模拟仅当前子进程退出。@returns 固定 true。 */
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => { this.emit('exit', 1); this.emit('close', 1); });
    return true;
  }
}

/** @brief 创建内存双工 IPC。@returns 父子端点。 */
function channel_pair(): { parent: fake_channel; child: fake_channel } {
  const parent = new fake_channel();
  const child = new fake_channel();
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}

const bootstrap = { text: '保留主回复，并在独立对话中检查这个问题。', roots: [path.resolve('build')], project_name: '测试项目', model: 'existing-model-id' };
const runtime = { executable_path: 'fake-electron', application_path: path.resolve('.'), packaged: false };

/** @brief 验证文本、根目录及字段白名单，并保证输入引用不会传播到子窗口。 */
test('side chat bootstrap has bounded text and explicit roots only', () => {
  const validated = validate_side_chat_bootstrap(bootstrap);
  assert.deepEqual(validated, bootstrap);
  assert.notEqual(validated.roots, bootstrap.roots);
  assert.deepEqual(validate_side_chat_bootstrap({ text: 'hello', roots: [] }), { text: 'hello', roots: [] });
  for (const invalid of [null, [], {}, { text: ' ', roots: [] }, { text: 'a'.repeat(64_001), roots: [] },
    { text: 'hello', roots: Array(17).fill(path.resolve('.')) }, { text: 'hello', roots: ['relative'] },
    { text: 'hello', roots: [path.resolve('.') + '\0'] }, { ...bootstrap, project_name: 'x'.repeat(201) },
    { ...bootstrap, credential: 'must-not-transfer' }, { ...bootstrap, mode: 'workspace-write' },
    { ...bootstrap, model: 1 }, { ...bootstrap, model: '' }, { ...bootstrap, model: 'x'.repeat(201) }, { ...bootstrap, model: 'invalid\0model' }]) {
    assert.throws(() => validate_side_chat_bootstrap(invalid));
  }
});

/** @brief 子窗口拿到草稿之前父请求不会完成，成功后提交一次并解除 IPC 引用。 */
test('side chat acknowledges ownership before committing without command-line prompt', async () => {
  const pair = channel_pair();
  let spawn_options: SpawnOptions | undefined;
  let spawn_arguments: string[] = [];
  const launcher = new side_chat_launcher(runtime, {
    spawn_child: (_executable, arguments_list, options) => { spawn_arguments = arguments_list; spawn_options = options; return pair.parent; },
    timeout_ms: 1000,
  });
  let accepted = false;
  const opened = launcher.open_side_chat(bootstrap).then(() => { accepted = true; });
  const handoff = await wait_for_side_chat_bootstrap(pair.child, 1000);
  assert.equal(accepted, false);
  assert.deepEqual(handoff.bootstrap, bootstrap);
  assert.deepEqual(spawn_arguments, [runtime.application_path, '--side-chat']);
  assert.ok(!spawn_arguments.some(value => value.includes(bootstrap.text)));
  assert.equal(spawn_options?.detached, true);
  assert.deepEqual(spawn_options?.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(spawn_options?.env?.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawn_options?.env?.OPENAI_API_KEY, undefined);
  const committed = handoff.acknowledge_ready();
  await opened;
  assert.equal(await committed, true);
  assert.equal(pair.parent.unreferenced, true);
  assert.equal(pair.parent.killed, false);
  assert.equal(launcher.active_count, 1);
  assert.equal(await handoff.acknowledge_ready(), true);
  pair.parent.emit('exit', 0);
  assert.equal(launcher.active_count, 0);
});

/** @brief 父请求超时后不会向迟到的子接收器提交，父消息必须保持可重试。 */
test('side chat timeout cancels an unaccepted child and never commits late', async () => {
  const pair = channel_pair();
  const launcher = new side_chat_launcher(runtime, { spawn_child: () => pair.parent, timeout_ms: 25 });
  const opened = launcher.open_side_chat(bootstrap);
  const failure = assert.rejects(opened, /超时/);
  const handoff = await wait_for_side_chat_bootstrap(pair.child, 500);
  await failure;
  assert.equal(await handoff.acknowledge_ready(), false);
  assert.equal(pair.parent.killed, true);
  assert.equal(launcher.active_count, 0);
  assert.ok(!pair.parent.sent.some(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'commit'));
});

/** @brief 接管确认后丢失 commit 仍保留子窗口草稿，且不会给出自动发送许可。 */
test('side chat lost commit leaves the accepted child draft available', async () => {
  const pair = channel_pair();
  pair.parent.lose_commit = true;
  const launcher = new side_chat_launcher(runtime, { spawn_child: () => pair.parent, timeout_ms: 1000 });
  const opened = launcher.open_side_chat(bootstrap);
  const handoff = await wait_for_side_chat_bootstrap(pair.child, 1000);
  const committed = handoff.acknowledge_ready();
  await opened;
  assert.equal(await committed, false);
  assert.deepEqual(handoff.bootstrap, bootstrap);
  assert.equal(pair.parent.killed, false);
  pair.parent.emit('exit', 0);
});

/** @brief 子初始化失败只返回固定消息，不传播底层详情。 */
test('side chat child rejection preserves parent ownership', async () => {
  const pair = channel_pair();
  const launcher = new side_chat_launcher(runtime, { spawn_child: () => pair.parent, timeout_ms: 1000 });
  const opened = launcher.open_side_chat(bootstrap);
  const failure = assert.rejects(opened, /原草稿仍保留/);
  const handoff = await wait_for_side_chat_bootstrap(pair.child, 1000);
  handoff.reject_bootstrap();
  await failure;
  assert.equal(await handoff.acknowledge_ready(), false);
  assert.equal(pair.parent.killed, true);
});

/** @brief 四个独立窗口同时存在时拒绝第五个，已退出窗口释放槽位。 */
test('side chat active window limit also counts detached accepted children', async () => {
  const pairs: ReturnType<typeof channel_pair>[] = [];
  const spawn_arguments: string[][] = [];
  const launcher = new side_chat_launcher({ ...runtime, packaged: true }, {
    spawn_child: (_executable, arguments_list) => { const pair = channel_pair(); pairs.push(pair); spawn_arguments.push(arguments_list); return pair.parent; },
    timeout_ms: 1000,
  });
  for (let index = 0; index < 4; index++) {
    const opened = launcher.open_side_chat(bootstrap);
    const handoff = await wait_for_side_chat_bootstrap(pairs[index].child, 1000);
    const committed = handoff.acknowledge_ready();
    await opened;
    assert.equal(await committed, true);
  }
  assert.equal(launcher.active_count, 4);
  assert.deepEqual(spawn_arguments[0], ['--side-chat']);
  await assert.rejects(launcher.open_side_chat(bootstrap), /最多打开 4/);
  assert.equal(pairs.length, 4);
  pairs[0].parent.emit('exit', 0);
  assert.equal(launcher.active_count, 3);
  const opened = launcher.open_side_chat(bootstrap);
  const handoff = await wait_for_side_chat_bootstrap(pairs[4].child, 1000);
  const committed = handoff.acknowledge_ready();
  await opened;
  assert.equal(await committed, true);
  for (const pair of pairs) pair.parent.emit('exit', 0);
});

/** @brief 启动失败和缺少 IPC 都以固定错误结束，不请求模型。 */
test('side chat startup errors and unavailable IPC are controlled', async () => {
  const launcher = new side_chat_launcher(runtime, { spawn_child: () => { throw new Error('fake secret diagnostic'); } });
  await assert.rejects(launcher.open_side_chat(bootstrap), error => error instanceof Error && !error.message.includes('secret') && error.message.includes('原草稿'));
  assert.equal(launcher.active_count, 0);
  const channel = new fake_channel();
  channel.connected = false;
  await assert.rejects(wait_for_side_chat_bootstrap(channel, 100), /没有收到有效/);
});

/** @brief 未准备时的伪造 commit 不会绕过本地草稿就绪步骤。 */
test('side chat ignores commit until a matching local readiness acknowledgement', async () => {
  const pair = channel_pair();
  const request_id = '11111111-1111-1111-1111-111111111111';
  const receiver = wait_for_side_chat_bootstrap(pair.child, 500);
  pair.parent.send({ protocol: 'ai-code-side-chat', version: 1, type: 'bootstrap', request_id, bootstrap });
  const handoff = await receiver;
  pair.parent.send({ protocol: 'ai-code-side-chat', version: 1, type: 'commit', request_id });
  await new Promise<void>(resolve => queueMicrotask(resolve));
  const committed = handoff.acknowledge_ready();
  pair.parent.send({ protocol: 'ai-code-side-chat', version: 1, type: 'cancel', request_id });
  assert.equal(await committed, false);
});
