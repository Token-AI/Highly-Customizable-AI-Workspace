/**
 * @file side_chat.ts
 * @brief 通过受限 Node IPC 将草稿交给独立窗口，保持主对话及其后台进程不受影响。
 */
import { spawn, type Serializable, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** @brief 仅通过 IPC 传输的侧边聊天初始内容，不包含账号或凭据。 */
export interface side_chat_bootstrap { text: string; roots: string[]; project_name?: string; model?: string }
/** @brief 主进程明确提供的 Electron 启动位置。 */
export interface side_chat_runtime { executable_path: string; application_path: string; packaged: boolean }
/** @brief 可注入的最小 IPC 通道，供纯 Node 测试代替真实进程。 */
export interface side_chat_channel extends EventEmitter {
  connected: boolean;
  send?: (message: Serializable, callback: (error: Error | null) => void) => boolean;
  disconnect(): void;
}
/** @brief 可独立运行且可追踪退出的子窗口进程。 */
export interface side_chat_child extends side_chat_channel { unref(): void; kill(): boolean }
/** @brief 草稿已抵达子进程；只有获得提交许可后才允许自动发送。 */
export interface side_chat_handoff {
  bootstrap: side_chat_bootstrap;
  /** @brief 在本地窗口可靠持有草稿后请求接管确认。@returns 父窗口已提交交接时返回 true。 */
  acknowledge_ready(): Promise<boolean>;
  /** @brief 在接管之前报告受控失败，父窗口保留原草稿。 */
  reject_bootstrap(): void;
}
/** @brief 注入假进程和短超时以测试交接，不改变产品的默认限制。 */
export interface side_chat_dependencies {
  spawn_child?: (executable: string, arguments_list: string[], options: SpawnOptions) => side_chat_child;
  timeout_ms?: number;
}

const protocol_name = 'ai-code-side-chat';
const protocol_version = 1;
const default_timeout_ms = 10_000;
const maximum_windows = 4;
const failure_message = '侧边聊天未能接管消息，原草稿仍保留。请重试。';

/** @brief 判断数据是否为普通 IPC 对象。@param value 待检查值。@returns 是否为非数组对象。 */
function is_record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @brief 验证并复制限制长度的初始草稿，丢弃引用共享的可能性。
 * @param value 调用者或 IPC 提供的未知对象。
 * @returns 仅含受支持字段的规范数据。
 */
export function validate_side_chat_bootstrap(value: unknown): side_chat_bootstrap {
  if (!is_record(value) || Object.keys(value).some(key => !['text', 'roots', 'project_name', 'model'].includes(key))
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 64_000
    || !Array.isArray(value.roots) || value.roots.length > 16
    || value.roots.some(root => typeof root !== 'string' || !root || root.length > 32_767 || root.includes('\0') || !path.isAbsolute(root))
    || (value.project_name !== undefined && (typeof value.project_name !== 'string' || value.project_name.length > 200 || value.project_name.includes('\0')))
    || (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || value.model.includes('\0')))) {
    throw new Error('侧边聊天内容或项目目录无效。');
  }
  return { text: value.text, roots: [...value.roots],
    ...(value.project_name === undefined ? {} : { project_name: value.project_name as string }),
    ...(value.model === undefined ? {} : { model: value.model as string }) };
}

/** @brief 构造不包含任意错误详情的协议消息。@param type 消息类别。@param request_id 本次交接标识。@returns 可序列化信封。 */
function envelope(type: string, request_id = ''): Record<string, Serializable> {
  return { protocol: protocol_name, version: protocol_version, type, request_id };
}

/** @brief 仅识别当前协议的消息。@param value 未知 IPC 值。@returns 合法协议对象或 null。 */
function protocol_message(value: unknown): Record<string, unknown> | null {
  return is_record(value) && value.protocol === protocol_name && value.version === protocol_version && typeof value.type === 'string' ? value : null;
}

/** @brief 关闭已经交付的 IPC 通道，不结束窗口进程。@param channel 要关闭的通道。 */
function disconnect_channel(channel: side_chat_channel): void {
  try { if (channel.connected) channel.disconnect(); } catch { /* Channel may have closed concurrently. */ }
}

/**
 * @brief 安全发送 IPC 数据，不向调用者暴露系统错误或环境信息。
 * @param channel 当前通道。
 * @param message 受限协议消息。
 * @param complete 发送已排队或失败后的回调。
 */
function send_message(channel: side_chat_channel, message: Serializable, complete: (success: boolean) => void): void {
  if (!channel.connected || !channel.send) { complete(false); return; }
  try { channel.send(message, error => complete(!error)); }
  catch { complete(false); }
}

/** @brief 管理至多四个独立子窗口；已完成交接的窗口不阻止父进程退出。 */
export class side_chat_launcher {
  private readonly children = new Set<side_chat_child>();
  private readonly runtime: side_chat_runtime;
  private readonly launch_process: NonNullable<side_chat_dependencies['spawn_child']>;
  private readonly timeout_ms: number;

  /** @brief 配置独立 Electron 进程启动器。@param runtime Electron 路径与打包状态。@param dependencies 纯测试依赖。 */
  constructor(runtime: side_chat_runtime, dependencies: side_chat_dependencies = {}) {
    this.runtime = runtime;
    this.launch_process = dependencies.spawn_child ?? ((executable, arguments_list, options) => spawn(executable, arguments_list, options));
    this.timeout_ms = dependencies.timeout_ms ?? default_timeout_ms;
  }

  /** @brief 返回仍被追踪的独立窗口数。@returns 尚未退出的子进程数量。 */
  get active_count(): number { return this.children.size; }

  /**
   * @brief 打开独立窗口并等待其可靠接管草稿，不等待模型回复。
   * @param value 仅含文本和显式根目录的初始数据。
   * @returns 子窗口持有草稿后完成；失败时调用者必须保留原草稿。
   */
  async open_side_chat(value: unknown): Promise<void> {
    const bootstrap = validate_side_chat_bootstrap(value);
    if (this.children.size >= maximum_windows) throw new Error('同时最多打开 4 个侧边聊天窗口。');
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'].includes(key.toUpperCase())) delete environment[key];
    }
    let child: side_chat_child;
    try {
      child = this.launch_process(this.runtime.executable_path,
        this.runtime.packaged ? ['--side-chat'] : [this.runtime.application_path, '--side-chat'],
        { detached: true, windowsHide: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: environment });
    } catch { throw new Error(failure_message); }
    this.children.add(child);
    const request_id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let bootstrap_sent = false;
      const timer = setTimeout(() => fail('侧边聊天启动超时，原草稿仍保留。'), this.timeout_ms);

      /** @brief 拒绝未完成交接的子进程，防止超时后迟到提交。@param message 受控错误提示。 */
      const fail = (message = failure_message): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('message', on_message);
        send_message(child, envelope('cancel', request_id), () => disconnect_channel(child));
        try { child.kill(); } catch { /* Only this unaccepted child is addressed. */ }
        child.unref();
        reject(new Error(message));
      };
      /** @brief 处理子窗口准备和接管消息，只有成功路径才发送 commit。@param value 未知 IPC 消息。 */
      const on_message = (value: unknown): void => {
        if (settled) return;
        const message = protocol_message(value);
        if (!message) return;
        if (message.type === 'receiver_ready' && !bootstrap_sent) {
          bootstrap_sent = true;
          send_message(child, { ...envelope('bootstrap', request_id), bootstrap: { ...bootstrap } }, success => { if (!success) fail(); });
          return;
        }
        if (!bootstrap_sent || message.request_id !== request_id) return;
        if (message.type === 'failed') { fail(); return; }
        if (message.type !== 'ready') return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('message', on_message);
        // Ownership is already accepted. A lost commit leaves a visible child draft, never a lost parent draft.
        child.unref();
        const disconnect_timer = setTimeout(() => disconnect_channel(child), 1000);
        disconnect_timer.unref();
        send_message(child, envelope('commit', request_id), () => { clearTimeout(disconnect_timer); disconnect_channel(child); });
        resolve();
      };
      child.on('message', on_message);
      child.on('error', () => fail());
      child.once('disconnect', () => { if (!settled) fail(); });
      child.once('exit', () => { this.children.delete(child); fail(); });
      child.once('close', () => { this.children.delete(child); fail(); });
    });
  }
}

/**
 * @brief 在 app.whenReady 之前安装子窗口接收器，绝不自行发送模型请求。
 * @param channel 真实子进程 IPC 或测试通道。
 * @param timeout_ms 未交接时的最长等待时间，产品默认十秒。
 * @returns 初始草稿及显式接管函数；接管函数只在父进程 commit 后返回 true。
 */
export function wait_for_side_chat_bootstrap(channel: side_chat_channel = process, timeout_ms = default_timeout_ms): Promise<side_chat_handoff> {
  return new Promise<side_chat_handoff>((resolve, reject) => {
    let phase: 'waiting' | 'received' | 'ready' | 'committed' | 'cancelled' = 'waiting';
    let request_id = '';
    let resolve_commit: (value: boolean) => void = () => undefined;
    const committed = new Promise<boolean>(resolve => { resolve_commit = resolve; });
    const timer = setTimeout(() => cancel(), timeout_ms);

    /** @brief 移除协议侦听和期限，不影响 Electron 窗口本身。 */
    const cleanup = (): void => {
      clearTimeout(timer);
      channel.removeListener('message', on_message);
      channel.removeListener('disconnect', on_disconnect);
      channel.removeListener('error', on_disconnect);
    };
    /** @brief 撤销尚未提交的交接；已经收到的草稿仍归子窗口显示。 */
    const cancel = (): void => {
      if (phase === 'committed' || phase === 'cancelled') return;
      const waiting = phase === 'waiting';
      phase = 'cancelled';
      cleanup();
      resolve_commit(false);
      if (waiting) reject(new Error('侧边聊天没有收到有效的初始消息。'));
    };
    /** @brief 连接断开时撤销自动发送许可。 */
    const on_disconnect = (): void => cancel();
    /** @brief 接收一次初始草稿，再等待匹配的提交或取消。@param value 未知 IPC 数据。 */
    const on_message = (value: unknown): void => {
      const message = protocol_message(value);
      if (!message) return;
      if (phase === 'waiting' && message.type === 'bootstrap') {
        if (typeof message.request_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.request_id)) { cancel(); return; }
        request_id = message.request_id;
        let bootstrap: side_chat_bootstrap;
        try { bootstrap = validate_side_chat_bootstrap(message.bootstrap); }
        catch { send_message(channel, envelope('failed', request_id), () => undefined); cancel(); return; }
        phase = 'received';
        resolve({
          bootstrap,
          /** @brief 声明草稿已在本地界面就绪，然后等待父进程提交。@returns 是否允许自动发送。 */
          acknowledge_ready(): Promise<boolean> {
            if (phase === 'received') {
              phase = 'ready';
              send_message(channel, envelope('ready', request_id), success => { if (!success) cancel(); });
            }
            return committed;
          },
          /** @brief 报告初始化失败，仅发送固定协议类别，不发送错误内容。 */
          reject_bootstrap(): void {
            if (phase === 'committed' || phase === 'cancelled') return;
            send_message(channel, envelope('failed', request_id), () => undefined);
            cancel();
          },
        });
        return;
      }
      if (message.request_id !== request_id) return;
      if (message.type === 'cancel') { cancel(); return; }
      if (message.type === 'commit' && phase === 'ready') {
        phase = 'committed';
        cleanup();
        resolve_commit(true);
      }
    };
    channel.on('message', on_message);
    channel.once('disconnect', on_disconnect);
    channel.once('error', on_disconnect);
    send_message(channel, envelope('receiver_ready'), success => { if (!success) cancel(); });
  });
}
