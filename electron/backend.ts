/**
 * @file backend.ts
 * @brief Owns the official Codex stdio process, subscription login and chat state.
 *
 * Application symbols use snake_case. JSON-RPC methods and payload keys retain
 * their official spellings at the transport boundary.
 */
import { spawn as node_spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { app_event, app_state, chat_message, chat_session, mode, model_info } from '../shared/types.js';

type object_value = Record<string, unknown>;
type spawn_server = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
/** @brief Supplies isolated storage, shell-owned login callbacks and transport test hooks. */
export interface backend_options {
  /// @brief Explicit initial project directory, or an empty string when no project is selected.
  cwd: string;
  /// @brief Dedicated CODEX_HOME; existing account credential files are never inspected.
  home: string;
  /// @brief Receives immutable state snapshots and explicit approval requests.
  emit: (event: app_event) => void;
  /// @brief Opens the validated HTTPS login URL in the application's own auth window.
  open_login: (url: string) => Promise<void>;
  /// @brief Closes the application's auth window without initiating a new login flow.
  close_login: () => void;
  /// @brief Optional executable override; production otherwise discovers official Codex.
  executable?: string;
  /// @brief Test process factory; production uses Node's built-in child_process.spawn.
  spawn?: spawn_server;
  /// @brief RPC response deadline, in milliseconds; defaults to 60 seconds.
  request_timeout_ms?: number;
  /// @brief Bound for each child shutdown wait, in milliseconds; defaults to 2 seconds.
  close_timeout_ms?: number;
  /// @brief Optional inherited environment for tests, filtered before child creation.
  env?: NodeJS.ProcessEnv;
}

const frame_limit = 8 * 1024 * 1024;
const queue_limit = 16 * 1024 * 1024;
const text_limit = 1024 * 1024;
const object = (value: unknown): object_value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as object_value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const bool = (value: unknown): boolean => value === true;
const error_text = (value: unknown): string => (value instanceof Error ? value.message : string(value, '操作未完成')).slice(0, 4000);
const has = (value: object_value, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * @brief Builds a child environment that cannot inherit API-key authentication.
 * @param source Parent environment; excluded credential values are not accessed.
 * @param home Dedicated Codex data directory for this client.
 * @returns A copy preserving unrelated variables and replacing CODEX_HOME.
 */
export function subscription_environment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const excluded = new Set(['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']);
  for (const key of Object.keys(source)) if (!excluded.has(key.toUpperCase())) result[key] = source[key];
  result.CODEX_HOME = home;
  return result;
}

function environment_value(source: NodeJS.ProcessEnv, name: string): string {
  const key = Object.keys(source).find(candidate => candidate.toUpperCase() === name);
  return key ? source[key] ?? '' : '';
}

async function existing_executable(candidate: string): Promise<string> {
  if (!candidate || (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe')) return '';
  try { return (await stat(candidate)).isFile() ? path.resolve(candidate) : ''; } catch { return ''; }
}

/**
 * @brief Finds Codex by explicit override, PATH, then newest official local installation.
 * @param environment Environment used for executable discovery, without reading credentials.
 * @returns An absolute executable path, or an empty string when none is usable.
 */
export async function find_codex_executable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = await existing_executable(environment_value(environment, 'AI_CODE_CODEX_PATH'));
  if (explicit) return explicit;
  const filename = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const entry of environment_value(environment, 'PATH').split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!directory) continue;
    const found = await existing_executable(path.join(directory, filename));
    if (found) return found;
  }
  const local = environment_value(environment, 'LOCALAPPDATA');
  if (!local) return '';
  const root = path.join(local, 'OpenAI', 'Codex', 'bin');
  let best = '', newest = -Infinity;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, 'codex.exe');
      try {
        const info = await stat(candidate);
        if (info.isFile() && info.mtimeMs > newest) { newest = info.mtimeMs; best = candidate; }
      } catch { /* A partially installed version is not usable. */ }
    }
  } catch { /* An official installation is optional until the user connects. */ }
  return best;
}

/**
 * @brief Validates the initial official login URL before passing it to the shell.
 * @param value Candidate URL received from account/login/start.
 * @returns True only for approved HTTPS origins without user information or alternate ports.
 */
export function allowed_login_url(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      (url.hostname === 'auth.openai.com' || url.hostname === 'chatgpt.com');
  } catch { return false; }
}

/** @brief Distinguishes explicit RPC rejection from an uncertain transport or timeout failure. */
class rpc_failure extends Error {
  constructor(readonly method: string, readonly kind: 'rpc' | 'timeout' | 'transport', message: string) { super(message); }
}
interface pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: object_value) => void;
  reject: (error: rpc_failure) => void;
}
interface pending_approval { rpc_id: string | number; thread_id: string; turn_id: string; can_accept: boolean; generation: number }
interface replacement_waiter {
  generation: number; operation: number; settled: boolean; timer: ReturnType<typeof setTimeout>;
  resolve: (status: string) => void; reject: (error: Error) => void;
}

/**
 * @brief Coordinates one app-server connection and one active conversation.
 *
 * Connection generations reject stale work after reconnect; operation and login
 * sequences prevent late responses from altering a newer turn or login attempt.
 */
export class codex_backend {
  /// @brief Current UI state; consumers receive cloned snapshots through the emit callback.
  state: app_state;
  private readonly options: backend_options;
  private readonly empty_workspace: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, pending>();
  private approvals = new Map<string, pending_approval>();
  private session_directories = new Map<string, string>();
  private item_details = new Map<string, string>();
  private generation = 0;
  private account_sequence = 0;
  private login_sequence = 0;
  private operation_sequence = 0;
  private directory_sequence = 0;
  private auth_operation = false;
  private next_id = 1;
  private login_id = '';
  private turn_id = '';
  private interrupted_turn_id = '';
  private finished_turns = new Set<string>();
  private disposed = false;
  private closing: Promise<void> | undefined;
  private terminating = new Set<Promise<void>>();
  private publish_timer: ReturnType<typeof setTimeout> | undefined;
  private resuming_thread = '';
  private resume_events: object_value[] = [];
  private queue_epoch = 0;
  private queue_paused = false;
  private draining_queue = false;
  private replacement: replacement_waiter | undefined;

  /**
   * @brief Creates an idle controller without spawning a process or reading credentials.
   * @param options Project, isolated storage, shell callbacks and optional test hooks.
   */
  constructor(options: backend_options) {
    this.options = options;
    this.empty_workspace = path.resolve(options.home, 'empty_workspace');
    this.state = {
      connected: false, connecting: false, authenticated: false, login_pending: false,
      busy: false, stopping: false, session_loading: false, preview: false,
      account: '尚未登录', quota: '', status: '连接 Codex 后，使用 ChatGPT 订阅额度', error: '',
      cwd: options.cwd && !this.is_empty_workspace(options.cwd) ? path.resolve(options.cwd) : '', model: '', mode: 'read-only', models: [],
      thread_id: '', messages: [], sessions: [], diff: '',
    };
    this.state.workspace_roots = this.state.cwd ? [this.state.cwd] : [];
    this.state.queued_messages = [];
  }

  /**
   * @brief Resolves the private runtime directory without inventing a selected UI project.
   * @returns The explicitly selected directory or the isolated empty workspace.
   */
  private effective_cwd(): string {
    return this.state.cwd || this.empty_workspace;
  }

  /**
   * @brief Identifies the reserved runtime directory used by conversations without a project.
   * @param directory Candidate directory from a saved thread or an explicit project selection.
   * @returns True for the internal workspace, with Windows path casing normalized.
   */
  private is_empty_workspace(directory: string): boolean {
    const absolute = path.resolve(directory);
    return process.platform === 'win32' ? absolute.toLowerCase() === this.empty_workspace.toLowerCase() : absolute === this.empty_workspace;
  }

  /**
   * @brief Compares normalized directory names without conflating parent and child roots.
   * @param first First absolute directory, or empty for no selected project.
   * @param second Second absolute directory, or empty for no selected project.
   * @returns True when both paths identify the same normalized directory name.
   */
  private same_directory(first: string, second: string): boolean {
    if (!first || !second) return first === second;
    const left = path.resolve(first), right = path.resolve(second);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  /**
   * @brief Returns only roots belonging to the supplied primary directory.
   * @param cwd Primary directory for a new or restored thread.
   * @returns Selected project roots when the primary matches; otherwise a single historical root.
   */
  private roots_for(cwd = this.effective_cwd()): string[] {
    if (this.is_empty_workspace(cwd)) return [];
    return this.same_directory(cwd, this.state.cwd) && this.state.workspace_roots?.length ? [...this.state.workspace_roots] : [cwd];
  }

  /**
   * @brief Validates real absolute project directories without following linked path segments.
   * @param directories User-selected roots, up to 16 entries; an empty list exits the project.
   * @returns Canonical directory paths, deduplicated while preserving primary-root order.
   * @throws Error On invalid paths, links, missing directories or use of the private workspace.
   */
  private async validate_directories(directories: string[]): Promise<string[]> {
    if (!Array.isArray(directories) || directories.length > 16) throw new Error('一个项目最多包含 16 个目录。');
    const roots: string[] = [], seen = new Set<string>();
    for (const directory of directories) {
      if (typeof directory !== 'string' || !directory.trim() || directory.length > 32767 || directory.includes('\0') || !path.isAbsolute(directory))
        throw new Error('请选择有效的绝对目录路径。');
      const absolute = path.resolve(directory);
      if (this.is_empty_workspace(absolute)) throw new Error('请选择项目目录，而非应用内部工作目录。');
      let current = path.parse(absolute).root;
      for (const segment of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new Error('不跟随符号链接或目录联接，请选择实际目录。');
      }
      if (!(await stat(absolute)).isDirectory()) throw new Error('项目路径必须是目录。');
      const canonical = path.resolve(await realpath(absolute));
      if (this.is_empty_workspace(canonical)) throw new Error('请选择项目目录，而非应用内部工作目录。');
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (!seen.has(key)) { roots.push(canonical); seen.add(key); }
    }
    return roots;
  }

  /**
   * @brief Drops unsent messages at conversation or account boundaries.
   * @param reason Explanation used to reject an outstanding stop-and-send wait.
   */
  private clear_queue(reason: string): void {
    ++this.queue_epoch; this.state.queued_messages = []; this.queue_paused = false;
    const waiting = this.replacement;
    this.replacement = undefined;
    if (waiting && !waiting.settled) {
      waiting.settled = true; clearTimeout(waiting.timer); waiting.reject(new Error(reason));
    }
  }

  /**
   * @brief Resolves the sole replacement-send waiter only for its original operation.
   * @param status Confirmed terminal turn status, including early local cancellation.
   * @param error Optional failure that prevents sending replacement text.
   */
  private settle_replacement(status: string, error?: Error): void {
    const waiting = this.replacement;
    if (!waiting || waiting.settled || waiting.generation !== this.generation || waiting.operation !== this.operation_sequence) return;
    waiting.settled = true; clearTimeout(waiting.timer);
    if (error) waiting.reject(error); else waiting.resolve(status);
  }

  /**
   * @brief Validates input controls without requiring the current model turn to be idle.
   * @param text Complete prompt text, subject to the same size and account rules as send.
   * @throws Error When input, account, model or controller state cannot accept the operation.
   */
  private control_text(text: string): void {
    let message = '';
    if (!this.state.connected || !this.state.authenticated || this.disposed) message = '请先登录 ChatGPT。';
    else if (this.state.session_loading || this.state.login_pending || this.auth_operation || this.replacement) message = '请等待当前操作完成后重试。';
    else if (typeof text !== 'string' || !text.trim()) message = '请输入消息内容。';
    else if (text.length > 64_000) message = '消息过长，请缩短至 64,000 个字符以内。';
    else if (!this.state.models.some(model => model.id === this.state.model)) message = '模型列表尚未就绪，请刷新后重试。';
    if (message) { this.notice(message); throw new Error(message); }
  }

  /**
   * @brief Sends queued text in FIFO order only after successful completion permits another turn.
   * @returns A submission error when the original item was retained, otherwise undefined.
   */
  private async drain_queue(): Promise<Error | undefined> {
    if (this.draining_queue) return;
    this.draining_queue = true;
    let failure: Error | undefined;
    try {
      while (!this.queue_paused && this.idle() && this.state.connected && this.state.authenticated && !this.state.login_pending && this.state.queued_messages?.length) {
        const entry = this.state.queued_messages.shift()!, epoch = this.queue_epoch;
        this.publish();
        try { await this.send(entry.text); }
        catch (error) {
          if (epoch === this.queue_epoch) {
            (this.state.queued_messages ??= []).unshift(entry); this.queue_paused = true; this.publish();
            failure = new Error(error_text(error));
          }
          break;
        }
      }
    } finally { this.draining_queue = false; }
    return failure;
  }

  /**
   * @brief Emits a cloned state and coalesces streaming updates within a 50 ms window.
   * @param delayed Whether a token/output update may wait for the current batch.
   * @returns Immediately; no events are emitted after disposal begins.
   */
  private publish(delayed = false): void {
    if (this.disposed) return;
    if (delayed) {
      if (!this.publish_timer) this.publish_timer = setTimeout(() => { this.publish_timer = undefined; this.publish(); }, 50);
      return;
    }
    if (this.publish_timer) { clearTimeout(this.publish_timer); this.publish_timer = undefined; }
    this.options.emit({ type: 'state', state: structuredClone(this.state) });
  }

  private notice(message: string): void {
    this.state.error = message;
    if (!this.state.busy && !this.state.session_loading && !this.state.connecting) this.state.status = message;
    this.publish();
  }

  private system(message: string): void {
    this.state.messages.push({ id: `system-${randomUUID()}`, role: 'system', text: message });
  }

  private close_login_window(): void {
    try { this.options.close_login(); } catch { /* Closing a destroyed auth window is harmless. */ }
  }

  /**
   * @brief Cancels request timers and rejects all unresolved RPC promises.
   * @param reason User-safe explanation of the connection change.
   */
  private reject_pending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new rpc_failure(entry.method, 'transport', reason));
    }
    this.pending.clear();
  }

  /**
   * @brief Invalidates connection-owned work before exposing a disconnected state.
   * @param reason User-safe error or shutdown description.
   */
  private disconnected(reason: string): void {
    this.clear_queue(reason);
    ++this.generation; ++this.account_sequence; ++this.login_sequence; ++this.operation_sequence;
    this.reject_pending(reason);
    this.approvals.clear(); this.login_id = ''; this.turn_id = ''; this.interrupted_turn_id = ''; this.finished_turns.clear();
    this.resuming_thread = ''; this.resume_events = [];
    this.auth_operation = false;
    delete this.state.account_email;
    Object.assign(this.state, {
      connected: false, connecting: false, authenticated: false, busy: false,
      stopping: false, session_loading: false, login_pending: false,
      account: '服务未连接', quota: '', status: reason, error: reason,
    } satisfies Partial<app_state>);
    this.close_login_window(); this.publish();
  }

  /**
   * @brief Stops an owned child process and closes its stdio handles.
   * @param child Process captured before the active connection is detached.
   * @returns After bounded process-tree and close-event waits finish.
   */
  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); return;
    }
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
    /// Stop the process tree while its root PID is alive. Windows taskkill receives
    /// an argument array and never runs through a command shell.
    if (process.platform === 'win32' && child.pid) {
      const system_root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      await new Promise<void>(resolve => {
        const killer = node_spawn(path.join(system_root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); resolve(); }, this.options.close_timeout_ms ?? 2000);
        killer.once('error', () => { clearTimeout(timer); resolve(); });
        killer.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let close_timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closed, new Promise<void>(resolve => { close_timer = setTimeout(resolve, this.options.close_timeout_ms ?? 2000); })]);
    if (close_timer) clearTimeout(close_timer);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }

  /**
   * @brief Detaches the active transport, updates state and waits for its shutdown.
   * @param reason User-safe explanation published before process termination.
   * @returns After the detached child's tracked termination finishes, if any.
   */
  private async disconnect(reason: string): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.disconnected(reason);
    if (child) await this.stop_child(child);
  }

  /**
   * @brief Tracks detached-child shutdown so concurrent dispose cannot finish early.
   * @param child Owned child to terminate exactly once through its current caller.
   * @returns The termination promise retained until the process cleanup completes.
   */
  private stop_child(child: ChildProcessWithoutNullStreams): Promise<void> {
    const stopping = this.terminate(child).finally(() => this.terminating.delete(stopping));
    this.terminating.add(stopping);
    return stopping;
  }

  /**
   * @brief Installs bounded JSONL framing and generation-scoped process listeners.
   * @param child Spawned process with independent stdin, stdout and stderr pipes.
   * @returns Immediately; malformed UTF-8, oversized frames or stream failure disconnect.
   */
  private attach(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    const generation = this.generation;
    let parts: Buffer[] = [], bytes = 0, stderr_tail = Buffer.alloc(0);
    let exit_timer: ReturnType<typeof setTimeout> | undefined;
    const active = () => this.child === child && this.generation === generation && !this.disposed;
    const fail = (reason: string) => { if (active()) void this.disconnect(reason); };
    const deliver = (data: Buffer) => {
      if (!active()) return;
      if (data.length && data[data.length - 1] === 13) data = data.subarray(0, -1);
      if (!data.length) return;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid message');
        this.receive(object(parsed));
      } catch { fail('Codex 返回了无效的协议消息，请重连后重试。'); }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!active()) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const piece = chunk.subarray(start, end);
        bytes += piece.length;
        if (bytes > frame_limit) { fail('Codex 消息超过 8 MiB，连接已停止。'); return; }
        if (piece.length) parts.push(piece);
        if (newline < 0) break;
        deliver(Buffer.concat(parts, bytes)); parts = []; bytes = 0;
        if (!active()) return;
        start = newline + 1;
      }
    });
    child.stdout.on('end', () => {
      if (bytes) { deliver(Buffer.concat(parts, bytes)); parts = []; bytes = 0; }
      if (active() && child.exitCode === null) {
        exit_timer = setTimeout(() => fail('Codex 已关闭通信通道，请重连。'), 100);
        exit_timer.unref();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      /// Drain separately and keep a bounded private tail. Raw stderr may contain
      /// credentials, signed URLs or prompts and is never forwarded to the UI.
      stderr_tail = Buffer.concat([stderr_tail, chunk]).subarray(-16 * 1024);
    });
    child.stdin.on('error', () => fail('无法向 Codex 发送消息，请重连。'));
    child.stdout.on('error', () => fail('无法读取 Codex 回复，请重连。'));
    child.stderr.on('error', () => { /* Exit/close reports the actual disconnect. */ });
    child.on('error', () => fail('无法启动 Codex。请检查官方 codex.exe 的位置和运行权限。'));
    child.on('exit', () => {
      /// A descendant may retain stdio after server exit. Bound the delay before
      /// updating the UI and rejecting requests if Node's close event cannot fire.
      if (!exit_timer) { exit_timer = setTimeout(() => fail('Codex 服务已退出，请重连。'), 500); exit_timer.unref(); }
    });
    child.on('close', (code: number | null) => {
      if (exit_timer) clearTimeout(exit_timer);
      stderr_tail = Buffer.alloc(0);
      fail(`Codex 服务已断开${code === null ? '' : `（退出码 ${code}）`}。请重连。`);
    });
  }

  /**
   * @brief Queues one complete JSON-RPC line within frame and stdin buffer limits.
   * @param value Protocol object with official wire-format property names.
   * @returns True if queued locally; this does not acknowledge server acceptance.
   */
  private write(value: object_value): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded || this.disposed) return false;
    const line = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes - 1 > frame_limit || child.stdin.writableLength + bytes > queue_limit) return false;
    try { child.stdin.write(line); return true; } catch { return false; }
  }

  /**
   * @brief Correlates an outgoing request with a response and a finite deadline.
   * @param method Official JSON-RPC method name.
   * @param params Method parameters retaining their official wire-format names.
   * @returns The response result object when the matching numeric ID arrives.
   * @throws rpc_failure On explicit rejection, deadline expiry or unavailable transport.
   */
  private request(method: string, params: object_value = {}): Promise<object_value> {
    const id = this.next_id++;
    return new Promise<object_value>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new rpc_failure(method, 'timeout', `${method} 请求超时`));
      }, this.options.request_timeout_ms ?? 60_000);
      this.pending.set(id, { method, resolve, reject, timer });
      if (!this.write({ id, method, params })) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new rpc_failure(method, 'transport', '服务连接不可用，请重连。'));
      }
    });
  }

  /**
   * @brief Sends a protocol notification that expects no response.
   * @param method Official JSON-RPC notification name.
   * @param params Wire-format notification parameters.
   * @throws rpc_failure When the notification cannot be queued.
   */
  private notify(method: string, params: object_value = {}): void {
    if (!this.write({ method, params })) throw new rpc_failure(method, 'transport', '服务连接不可用，请重连。');
  }

  /**
   * @brief Applies failure state only to the connection that initiated the operation.
   * @param error RPC, transport or local validation error.
   * @param generation Connection generation captured before awaiting the operation.
   * @returns After any required disconnect; a rejected interrupt preserves the active turn.
   */
  private async operation_failure(error: unknown, generation: number): Promise<void> {
    if (generation !== this.generation || this.disposed) return;
    this.queue_paused = true;
    this.settle_replacement('failed', error instanceof Error ? error : new Error(error_text(error)));
    if (error instanceof rpc_failure && error.kind === 'rpc' && error.method === 'turn/interrupt' && this.state.busy) {
      /// A rejected interrupt does not terminate the model's active turn.
      this.state.stopping = false; this.interrupted_turn_id = '';
      this.state.status = '停止请求未完成，可以重试停止'; this.notice(error_text(error));
      return;
    }
    if (error instanceof rpc_failure && error.kind !== 'rpc') {
      await this.disconnect(`${error_text(error)}；连接已停止，避免重复执行。`);
    } else {
      this.state.busy = false; this.state.stopping = false; this.state.session_loading = false;
      this.turn_id = ''; this.interrupted_turn_id = ''; this.notice(error_text(error));
    }
  }

  /**
   * @brief Starts official app-server under isolated CODEX_HOME and initializes the protocol.
   * @returns After handshake and metadata refresh, or after publishing a connection error.
   * @note Busy turns, history restoration and authentication operations block reconnect.
   */
  async connect(): Promise<void> {
    if (this.disposed || this.state.connecting || this.auth_operation) return;
    if (this.state.busy || this.state.session_loading || this.state.login_pending) { this.notice('请先完成或停止当前操作再重连。'); return; }
    const old = this.child; this.child = undefined;
    ++this.generation; ++this.operation_sequence; ++this.account_sequence;
    this.reject_pending('正在建立新连接。');
    this.clear_queue('正在重新连接，待发送消息已取消。');
    this.approvals.clear(); this.turn_id = ''; this.login_id = '';
    /// Turn IDs and buffered events belong to one connection generation. A new
    /// server must not inherit stale-completion filters from its predecessor.
    this.finished_turns.clear(); this.interrupted_turn_id = ''; this.item_details.clear();
    this.resuming_thread = ''; this.resume_events = [];
    delete this.state.account_email;
    Object.assign(this.state, {
      connected: false, connecting: true, authenticated: false, login_pending: false,
      busy: false, stopping: false, session_loading: false, thread_id: '', messages: [], diff: '',
      models: [], model: '', account: '尚未登录', quota: '', status: '正在连接本机 Codex…', error: '',
    } satisfies Partial<app_state>);
    this.close_login_window(); this.publish();
    const generation = this.generation;
    try {
      if (old) await this.stop_child(old);
      const environment = this.options.env ?? process.env;
      const executable = this.options.executable || await find_codex_executable(environment);
      if (!executable) throw new Error('未找到 codex.exe。请安装官方 Codex，或设置 AI_CODE_CODEX_PATH。');
      const home = path.resolve(this.options.home);
      await mkdir(home, { recursive: true });
      await mkdir(this.empty_workspace, { recursive: true });
      const runtime_cwd = this.effective_cwd();
      if (!(await stat(runtime_cwd)).isDirectory()) throw new Error('项目文件夹不存在。');
      if (generation !== this.generation || this.disposed) return;
      const spawn_server: spawn_server = this.options.spawn ?? ((file, args, options) => node_spawn(file, args, { ...options, stdio: 'pipe' }));
      const child = spawn_server(executable, ['app-server', '--listen', 'stdio://'], {
        cwd: runtime_cwd, env: subscription_environment(environment, home), windowsHide: true, shell: false,
      });
      this.attach(child);
      await this.request('initialize', { clientInfo: { name: 'ai_code_desktop', title: 'AI Code', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      if (generation !== this.generation || this.disposed) return;
      this.notify('initialized');
      this.state.connected = true; this.state.connecting = false; this.state.status = '服务已连接，请登录 ChatGPT'; this.publish();
      await this.refresh();
    } catch (error) {
      if (generation === this.generation && !this.disposed) await this.disconnect(error_text(error));
    }
  }

  /**
   * @brief Reads account metadata and accepts only ChatGPT subscription authentication.
   * @returns After applying the newest account response for the current connection.
   * @throws rpc_failure When account/read fails; callers choose the UI failure policy.
   * @note Optional account_email contains only the server-provided email, never the plan label.
   */
  private async read_account(): Promise<void> {
    const generation = this.generation, sequence = ++this.account_sequence;
    const result = await this.request('account/read', { refreshToken: false });
    if (generation !== this.generation || sequence !== this.account_sequence) return;
    const account = object(result.account);
    this.state.authenticated = account.type === 'chatgpt';
    delete this.state.account_email;
    if (this.state.authenticated) {
      const email = string(account.email).trim();
      if (email) this.state.account_email = email;
      this.state.account = [string(account.email, 'ChatGPT'), string(account.planType)].filter(Boolean).join(' · ');
      if (!this.state.busy && !this.state.session_loading) this.state.status = 'ChatGPT 已连接 · 使用 Codex 订阅额度';
    } else {
      this.clear_queue('账号已退出，待发送消息已取消。');
      this.state.account = '尚未登录 ChatGPT'; this.state.quota = ''; this.state.models = []; this.state.model = '';
      if (!this.state.busy && !this.state.session_loading)
        this.state.status = result.account == null ? '登录 ChatGPT 后开始对话' : '当前凭证不是 ChatGPT 订阅，请重新登录';
    }
    this.publish();
  }

  /**
   * @brief Pages model metadata and preserves a valid selected model across refreshes.
   * @returns After updating the current authenticated connection's visible model list.
   * @throws rpc_failure If a model/list page fails before completion.
   */
  private async load_models(): Promise<void> {
    const generation = this.generation;
    const models: model_info[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor = '', default_model = '';
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const entry of array(result.data)) {
        const model = object(entry), id = string(model.model, string(model.id));
        if (!id || bool(model.hidden) || seen.has(id)) continue;
        seen.add(id); models.push({ id, name: string(model.displayName, id), description: string(model.description) });
        if (bool(model.isDefault)) default_model = id;
      }
      cursor = string(result.nextCursor);
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    } while (models.length < 500);
    if (generation !== this.generation || !this.state.authenticated) return;
    this.state.models = models;
    if (!seen.has(this.state.model)) this.state.model = default_model || models[0]?.id || '';
    this.publish();
  }

  /**
   * @brief Converts Codex usage percentages into bounded remaining-quota labels.
   * @param result Rate-limit response or notification in its official wire format.
   */
  private update_quota(result: object_value): void {
    const by_id = object(result.rateLimitsByLimitId);
    const limits = object(by_id.codex ?? result.rateLimits);
    const primary = object(limits.primary), secondary = object(limits.secondary);
    const describe = (window: object_value, fallback: string) => {
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return '';
      const label = window.windowDurationMins === 300 ? '5 小时' : window.windowDurationMins === 10080 ? '每周' : fallback;
      return `${label}剩余 ${Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))}%`;
    };
    this.state.quota = [describe(primary, '额度'), describe(secondary, '周期')].filter(Boolean).join(' · ') || '额度信息暂不可用';
    this.publish();
  }

  private async read_quota(): Promise<void> {
    const generation = this.generation;
    try {
      const result = await this.request('account/rateLimits/read');
      if (generation === this.generation && this.state.authenticated) this.update_quota(result);
    } catch {
      if (generation === this.generation) { this.state.quota = '额度信息暂不可用'; this.publish(); }
    }
  }

  /**
   * @brief Loads saved conversations, including appServer sessions created by this client.
   * @returns After replacing the current connection's history index and directory cache.
   * @throws rpc_failure If a thread/list page cannot be retrieved.
   */
  private async list_sessions(): Promise<void> {
    const generation = this.generation;
    const sessions: chat_session[] = [], directories = new Map<string, string>(), ids = new Set<string>(), cursors = new Set<string>();
    let cursor = '';
    do {
      const result = await this.request('thread/list', { limit: 50, archived: false, sourceKinds: ['appServer', 'cli', 'vscode'], ...(cursor ? { cursor } : {}) });
      for (const value of array(result.data)) {
        const entry = object(value), id = string(entry.id);
        if (!id || ids.has(id)) continue;
        ids.add(id);
        sessions.push({ id, title: string(entry.name, string(entry.preview, '新会话')).replace(/[\r\n]+/g, ' ').slice(0, 160) || '新会话',
          ...(typeof entry.updatedAt === 'number' ? { updated_at: entry.updatedAt } : {}) });
        directories.set(id, string(entry.cwd));
      }
      cursor = string(result.nextCursor);
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    } while (sessions.length < 500);
    if (generation !== this.generation) return;
    this.state.sessions = sessions; this.session_directories = directories; this.publish();
  }

  /**
   * @brief Refreshes account, conversation history, model catalog and subscription quota.
   * @returns After metadata settles; failures are published without clearing a running turn.
   */
  async refresh(): Promise<void> {
    if (!this.state.connected || this.disposed || this.auth_operation) return;
    const generation = this.generation;
    try {
      await this.read_account();
      if (generation !== this.generation) return;
      const tasks = [this.list_sessions()];
      if (this.state.authenticated) tasks.push(this.load_models(), this.read_quota());
      const results = await Promise.allSettled(tasks);
      for (const result of results) if (result.status === 'rejected' && generation === this.generation) this.notice(error_text(result.reason));
    } catch (error) { if (generation === this.generation) this.notice(error_text(error)); }
  }

  /**
   * @brief Begins managed ChatGPT login in the shell-owned authentication window.
   * @returns After the window opens or an error is published, not after authentication.
   * @note Sequence checks cancel late login/start responses instead of opening stale windows.
   */
  async login(): Promise<void> {
    if (!this.state.connected || this.state.busy || this.state.session_loading || this.state.login_pending || this.state.authenticated || this.disposed || this.auth_operation) return;
    const generation = this.generation, sequence = ++this.login_sequence;
    this.state.login_pending = true; this.state.error = ''; this.state.status = '正在准备 ChatGPT 登录…'; this.publish();
    try {
      const result = await this.request('account/login/start', { type: 'chatgpt' });
      if (generation !== this.generation) return;
      const login_id = string(result.loginId);
      if (sequence !== this.login_sequence || !this.state.login_pending) {
        if (login_id) await this.request('account/login/cancel', { loginId: login_id });
        return;
      }
      const url = string(result.authUrl);
      this.login_id = login_id;
      if (result.type !== 'chatgpt' || !login_id || !allowed_login_url(url)) throw new Error('Codex 未返回有效的 ChatGPT 登录地址。');
      await this.options.open_login(url);
      if (sequence !== this.login_sequence || generation !== this.generation) { this.close_login_window(); return; }
      this.state.status = '请在应用内登录窗口完成 ChatGPT 登录'; this.publish();
    } catch (error) {
      if (generation !== this.generation || sequence !== this.login_sequence) return;
      const id = this.login_id; this.login_id = ''; this.state.login_pending = false; ++this.login_sequence;
      this.close_login_window();
      if (id) void this.request('account/login/cancel', { loginId: id }).catch(() => {});
      if (error instanceof rpc_failure && error.kind !== 'rpc') await this.operation_failure(error, generation);
      else this.notice(error_text(error));
    }
  }

  /**
   * @brief Invalidates the pending login attempt and closes its embedded auth window.
   * @returns After cancellation is acknowledged when a server login ID is available.
   * @note A login/start response still in flight is canceled when its ID later arrives.
   */
  async cancel_login(): Promise<void> {
    if (!this.state.login_pending && !this.login_id) { this.close_login_window(); return; }
    const generation = this.generation, login_id = this.login_id;
    ++this.login_sequence; this.login_id = ''; this.state.login_pending = false;
    this.close_login_window(); this.state.status = '已取消登录'; this.publish();
    if (!login_id || !this.state.connected) return;
    try { await this.request('account/login/cancel', { loginId: login_id }); }
    catch (error) { await this.operation_failure(error, generation); }
  }

  /**
   * @brief Logs out the isolated Codex account while preventing concurrent chat mutations.
   * @returns After logout and refresh, or after publishing a failure with account state preserved.
   * @note Authentication is cleared only after server acknowledgment or transport disconnection.
   */
  async logout(): Promise<void> {
    if (!this.state.connected || this.state.busy || this.state.session_loading || this.disposed || this.auth_operation) return;
    const generation = this.generation;
    ++this.account_sequence; this.auth_operation = true;
    this.state.status = '正在退出 ChatGPT…'; this.publish();
    try {
      await this.cancel_login();
      if (generation !== this.generation) return;
      await this.request('account/logout');
      if (generation !== this.generation) return;
      ++this.account_sequence; this.auth_operation = false;
      delete this.state.account_email;
      Object.assign(this.state, { authenticated: false, account: '尚未登录 ChatGPT', quota: '', models: [], model: '' } satisfies Partial<app_state>);
      this.new_chat(); await this.refresh();
    } catch (error) { await this.operation_failure(error, generation); }
    finally { if (generation === this.generation) this.auth_operation = false; }
  }

  private idle(): boolean { return !this.state.busy && !this.state.session_loading && !this.disposed && !this.auth_operation && !this.replacement; }

  /**
   * @brief Clears the displayed conversation so the next send creates a new thread.
   * @returns Immediately; ignored while a turn, history load or authentication mutation runs.
   */
  new_chat(): void {
    if (!this.idle()) return;
    this.clear_queue('会话已切换，待发送消息已取消。');
    ++this.operation_sequence; this.turn_id = ''; this.interrupted_turn_id = ''; this.item_details.clear(); this.approvals.clear();
    Object.assign(this.state, { thread_id: '', messages: [], diff: '', error: '', status: this.state.authenticated ? '新会话 · 准备就绪' : '登录 ChatGPT 后开始对话' } satisfies Partial<app_state>);
    this.publish();
  }

  /**
   * @brief Selects a listed model for subsequent turns when the controller is idle.
   * @param id Model identifier obtained from the visible catalog.
   * @returns Immediately; unknown models and changes during active operations are ignored.
   */
  set_model(id: string): void {
    if (!this.idle() || !this.state.models.some(model => model.id === id)) return;
    this.state.model = id; this.publish();
  }

  /**
   * @brief Changes sandbox mode and starts a fresh conversation under the new policy.
   * @param mode Read-only discussion or workspace-write coding mode.
   * @returns Immediately; unchanged, invalid or busy-state requests have no effect.
   * @throws Error If workspace writing is requested without an explicitly selected project.
   */
  set_mode(mode: mode): void {
    if (mode === 'workspace-write' && !this.state.cwd) {
      const message = '请先选择项目文件夹，再启用代码修改模式。';
      this.notice(message); throw new Error(message);
    }
    if (!this.idle() || (mode !== 'read-only' && mode !== 'workspace-write') || this.state.mode === mode) return;
    this.state.mode = mode; this.new_chat();
  }

  /**
   * @brief Keeps the single-directory API as a wrapper around project-root selection.
   * @param directory One explicitly selected absolute project directory.
   * @returns After the directory is validated and the previous conversation is cleared.
   * @throws Error On invalid directories or a conflicting active operation.
   */
  async set_project(directory: string): Promise<void> {
    await this.set_directories([directory]);
  }

  /**
   * @brief Atomically selects all project directories or returns to a projectless conversation.
   * @param directories Ordered absolute roots; the first becomes cwd, and [] exits the project.
   * @returns After validated roots are committed and a new conversation is published.
   * @throws Error On invalid, busy or superseded requests; existing project state remains intact.
   */
  async set_directories(directories: string[]): Promise<void> {
    const sequence = ++this.directory_sequence, operation = this.operation_sequence;
    try {
      if (!this.idle() || this.state.login_pending) throw new Error('请等待当前操作完成，再切换项目目录。');
      const roots = await this.validate_directories(directories);
      if (!this.idle() || this.state.login_pending || sequence !== this.directory_sequence || operation !== this.operation_sequence)
        throw new Error('项目切换已被其他操作取代，请重试。');
      this.state.cwd = roots[0] || ''; this.state.workspace_roots = roots;
      if (!roots.length) this.state.mode = 'read-only';
      this.new_chat();
    } catch (error) { const message = error_text(error); this.notice(message); throw new Error(message); }
  }

  /**
   * @brief Maps current application settings to Codex thread creation/resume parameters.
   * @param cwd Explicit project or isolated runtime directory governing sandbox context.
   * @param roots Validated directories belonging to that primary directory.
   * @returns Official camelCase wire keys with untrusted approval policy and user review.
   */
  private thread_options(cwd = this.effective_cwd(), roots = this.roots_for(cwd)): object_value {
    const no_project = roots.length === 0;
    const read_only = no_project || this.state.mode === 'read-only';
    const instructions = no_project ?
      "You are a helpful assistant in AI Code. Reply in the user's language. No project is selected. The working directory is an empty private runtime directory, not a user project. Answer using the conversation only. Do not inspect files or directories, run commands, or modify files." : read_only ?
      "You are a helpful assistant in AI Code. Reply in the user's language. This is a read-only conversation: explain and discuss code, do not modify files." :
      "You are a helpful coding assistant in AI Code. Reply in the user's language. Work in the selected project and explain changes clearly.";
    return {
      cwd, modelProvider: 'openai', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: read_only ? 'read-only' : 'workspace-write',
      developerInstructions: instructions + (no_project ? '' : `\nThe selected project consists of all directories in this JSON list: ${JSON.stringify(roots)}. Treat them as one project. File changes must remain within these directories.`),
    };
  }

  /**
   * @brief Supplies the official per-turn policy so resumed threads cannot retain unrelated write roots.
   * @returns A readOnly policy or workspaceWrite limited to the current project's complete root list.
   */
  private sandbox_policy(): object_value {
    const roots = this.roots_for();
    return this.state.mode === 'workspace-write' && roots.length ?
      { type: 'workspaceWrite', writableRoots: roots, networkAccess: false } : { type: 'readOnly' };
  }

  /**
   * @brief Submits one user message, creating a thread first when necessary.
   * @param text Complete user prompt and any explicitly attached context, up to 64,000 characters.
   * @returns After submission acknowledgment or early cancellation, not after streamed completion.
   * @throws Error If authentication, idle-state, length or selected-model validation fails.
   * @throws rpc_failure If the server explicitly rejects submission before accepting a turn.
   * @note Uncertain transport failures disconnect; failures after acceptance never restore drafts.
   */
  async send(text: string): Promise<void> {
    const refuse = (message: string): never => { this.notice(message); throw new Error(message); };
    if (!this.state.connected || !this.state.authenticated) refuse('请先登录 ChatGPT。');
    if (!this.idle()) refuse('请等待当前操作完成，或先停止回复。');
    if (this.state.login_pending) refuse('请先完成或取消登录。');
    if (typeof text !== 'string' || !text.trim()) return;
    if (text.length > 64_000) refuse('消息过长，请缩短至 64,000 个字符以内。');
    if (!this.state.models.some(model => model.id === this.state.model)) refuse('模型列表尚未就绪，请刷新后重试。');
    const generation = this.generation, sequence = ++this.operation_sequence;
    this.turn_id = ''; this.interrupted_turn_id = ''; this.item_details.clear();
    Object.assign(this.state, { busy: true, stopping: false, status: '正在发送…', error: '', diff: '' } satisfies Partial<app_state>);
    const user_message: chat_message = { id: `local-${randomUUID()}`, role: 'user', text };
    let turn_accepted = false;
    this.state.messages.push(user_message); this.publish();
    try {
      if (!this.state.thread_id) {
        const result = await this.request('thread/start', this.thread_options());
        if (generation !== this.generation || sequence !== this.operation_sequence) return;
        this.state.thread_id = string(object(result.thread).id);
        if (!this.state.thread_id) throw new Error('服务未返回会话编号。');
      }
      if (this.state.stopping) {
        this.state.busy = false; this.state.stopping = false; this.state.status = '已取消发送';
        this.state.messages = this.state.messages.filter(message => message !== user_message);
        this.settle_replacement('interrupted');
        this.publish(); return;
      }
      const result = await this.request('turn/start', { threadId: this.state.thread_id, model: this.state.model,
        cwd: this.effective_cwd(), approvalPolicy: 'untrusted', sandboxPolicy: this.sandbox_policy(), input: [{ type: 'text', text }] });
      turn_accepted = true;
      if (generation !== this.generation || sequence !== this.operation_sequence || !this.state.busy) return;
      const id = string(object(result.turn).id);
      if (!id) throw new Error('服务未返回回复编号。');
      this.turn_id = id;
      if (this.state.stopping) await this.interrupt_turn();
      else { this.state.status = '正在思考…'; this.publish(); }
    } catch (error) {
      if (sequence !== this.operation_sequence) return;
      const refused = !turn_accepted && !this.turn_id && error instanceof rpc_failure && error.kind === 'rpc' &&
        (error.method === 'thread/start' || error.method === 'turn/start');
      if (refused) this.state.messages = this.state.messages.filter(message => message !== user_message);
      await this.operation_failure(error, generation);
      /// Restore drafts only for an explicit submission rejection. Errors after
      /// acceptance must not restore text that was already sent to the server.
      if (refused) throw error;
    }
  }

  /**
   * @brief Adds text to the current conversation's FIFO and explicitly resumes a paused queue.
   * @param text User prompt to submit after a successful active-turn completion.
   * @returns After the queued entry is published; idle controllers begin submission asynchronously.
   * @throws Error On invalid input, unavailable account, stopping state or a full queue.
   */
  async enqueue(text: string): Promise<void> {
    this.control_text(text);
    if (this.state.stopping) { const message = '请等待回复停止后再添加待发送消息。'; this.notice(message); throw new Error(message); }
    if ((this.state.queued_messages?.length ?? 0) >= 20) { const message = '待发送队列最多容纳 20 条消息。'; this.notice(message); throw new Error(message); }
    (this.state.queued_messages ??= []).push({ id: randomUUID(), text });
    this.queue_paused = false; this.publish();
    void this.drain_queue();
  }

  /**
   * @brief Removes an unsent queue entry without affecting an already submitted turn.
   * @param id Opaque queued-message identifier shown by the renderer.
   * @returns Immediately; stale identifiers have no effect.
   */
  remove_queued(id: string): void {
    const entries = this.state.queued_messages;
    if (!entries?.some(entry => entry.id === id)) return;
    this.state.queued_messages = entries.filter(entry => entry.id !== id);
    if (!this.state.queued_messages.length) this.queue_paused = false;
    this.publish();
  }

  /**
   * @brief Explicitly resumes a paused FIFO while no other turn is running.
   * @returns After the next queued item is submitted, or immediately for an empty queue.
   * @throws Error On unavailable state or rejected submission; the original queue item remains.
   */
  async resume_queue(): Promise<void> {
    const first = this.state.queued_messages?.[0];
    if (!first) return;
    this.control_text(first.text);
    if (!this.idle()) { const message = '请等待当前回复结束后再继续队列。'; this.notice(message); throw new Error(message); }
    this.queue_paused = false; this.publish();
    const failure = await this.drain_queue();
    if (failure) throw failure;
  }

  /**
   * @brief Steers only the currently active turn using its expected server turn ID.
   * @param text Additional user guidance to append to the active response.
   * @returns After the server acknowledges guidance for that same turn.
   * @throws Error On invalid state or rejection; callers retain their draft and active busy state.
   */
  async steer(text: string): Promise<void> {
    this.control_text(text);
    if (!this.state.busy || !this.turn_id || this.state.stopping) {
      const message = '当前回复尚未开始或正在停止，无法引导；可以稍后重试。'; this.notice(message); throw new Error(message);
    }
    const generation = this.generation, operation = this.operation_sequence, turn_id = this.turn_id, thread_id = this.state.thread_id;
    const user_message: chat_message = { id: `local-${randomUUID()}`, role: 'user', text };
    this.state.messages.push(user_message); this.publish();
    try {
      const response = await this.request('turn/steer', { threadId: thread_id, expectedTurnId: turn_id, input: [{ type: 'text', text }] });
      if (string(response.turnId) !== turn_id) throw new Error('服务确认的引导回合与当前请求不一致。');
      /// The optimistic message is already attached to its original conversation;
      /// a late acknowledgment never appends text to a newer turn or conversation.
    } catch (error) {
      const previous_count = this.state.messages.length;
      this.state.messages = this.state.messages.filter(message => message !== user_message);
      if (generation === this.generation && operation === this.operation_sequence && !this.disposed) {
        if (error instanceof rpc_failure && error.kind !== 'rpc') await this.operation_failure(error, generation);
        else this.notice(error_text(error));
      } else if (this.state.messages.length !== previous_count) this.publish();
      throw new Error(error_text(error));
    }
  }

  /**
   * @brief Pauses the old queue, confirms the active turn ended, then sends only the replacement.
   * @param text New user message retained by the caller if stopping or sending fails.
   * @returns After replacement submission, never merely after interrupt acknowledgment.
   * @throws Error On rejected interruption, failed old turn, cancellation, timeout or send rejection.
   */
  async stop_and_send(text: string): Promise<void> {
    this.control_text(text); this.queue_paused = true;
    if (!this.state.busy) { await this.send(text); return; }
    const generation = this.generation, operation = this.operation_sequence;
    let resolve_completion!: (status: string) => void, reject_completion!: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => { resolve_completion = resolve; reject_completion = reject; });
    /// A transport failure can settle completion while stop() is still awaiting
    /// its own RPC. Attach a handler immediately until the result is awaited below.
    void completion.catch(() => {});
    const waiting: replacement_waiter = {
      generation, operation, settled: false, resolve: resolve_completion, reject: reject_completion,
      timer: setTimeout(() => this.settle_replacement('failed', new rpc_failure('turn/interrupt', 'timeout', '等待当前回复停止超时')),
        this.options.request_timeout_ms ?? 60_000),
    };
    this.replacement = waiting;
    try {
      await this.stop();
      const status = await completion;
      if (generation !== this.generation || operation !== this.operation_sequence || this.replacement !== waiting)
        throw new Error('当前会话已变化，未发送替换消息。');
      if (status !== 'completed' && status !== 'interrupted') throw new Error('原回复未正常停止，未发送替换消息。');
      this.replacement = undefined;
      await this.send(text);
    } catch (error) {
      if (generation === this.generation && operation === this.operation_sequence && error instanceof rpc_failure && error.kind !== 'rpc')
        await this.operation_failure(error, generation);
      throw new Error(error_text(error));
    } finally {
      clearTimeout(waiting.timer);
      if (this.replacement === waiting) this.replacement = undefined;
    }
  }

  /**
   * @brief Sends at most one interrupt request for the currently known active turn ID.
   * @returns After interrupt acknowledgment; turn/completed owns the transition to idle.
   * @throws rpc_failure On rejection or uncertain delivery; callers retain or disconnect state.
   */
  private async interrupt_turn(): Promise<void> {
    if (!this.turn_id || this.interrupted_turn_id === this.turn_id || !this.state.busy) return;
    this.interrupted_turn_id = this.turn_id;
    await this.request('turn/interrupt', { threadId: this.state.thread_id, turnId: this.turn_id });
  }

  /**
   * @brief Declines pending approvals and requests interruption of the active response.
   * @returns After the interrupt request settles, while completion may still be pending.
   * @note Stopping before thread creation completes suppresses turn submission entirely.
   */
  async stop(): Promise<void> {
    if (!this.state.busy || this.disposed) return;
    const generation = this.generation, sequence = this.operation_sequence;
    this.queue_paused = true;
    this.state.stopping = true; this.state.status = '正在停止回复…'; this.publish();
    for (const [id, approval] of this.approvals) {
      if (approval.thread_id === this.state.thread_id) { this.write({ id: approval.rpc_id, result: { decision: 'decline' } }); this.approvals.delete(id); }
    }
    try { await this.interrupt_turn(); } catch (error) { if (sequence === this.operation_sequence) await this.operation_failure(error, generation); }
  }

  /**
   * @brief Converts supported Codex history items to bounded application messages.
   * @param value Wire-format user, assistant, command or file-change item.
   * @returns A display message, or undefined for unsupported item kinds.
   */
  private message_from_item(value: unknown): chat_message | undefined {
    const item = object(value), id = string(item.id, `history-${randomUUID()}`), type = string(item.type);
    if (type === 'agentMessage') return { id, role: 'assistant', text: string(item.text).slice(0, text_limit) };
    if (type === 'userMessage') return { id, role: 'user', text: array(item.content).map(part => object(part).type === 'text' ? string(object(part).text) : '').join('').slice(0, text_limit) };
    if (type === 'commandExecution') return { id, role: 'tool', text: [string(item.command), string(item.status), string(item.aggregatedOutput).slice(0, 16_000)].filter(Boolean).join('\n') };
    if (type === 'fileChange') return { id, role: 'tool', text: `文件修改 · ${string(item.status)}\n${this.file_diff(item)}` };
    return undefined;
  }

  private file_diff(item: object_value): string {
    return array(item.changes).map(value => { const change = object(value); return `${string(change.path)}\n${string(change.diff)}`; }).join('\n').slice(0, text_limit);
  }

  /**
   * @brief Reads recent wrapped history items and restores chronological display order.
   * @param thread_id Persisted thread identifier passed as the wire-format threadId key.
   * @returns Display messages and a flag indicating omitted older history.
   * @throws rpc_failure If pagination is unavailable or a history request fails.
   */
  private async history(thread_id: string): Promise<{ messages: chat_message[]; truncated: boolean }> {
    const items: unknown[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor = '';
    do {
      const page = await this.request('thread/items/list', { threadId: thread_id, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
      for (const entry of array(page.data)) {
        const item = object(object(entry).item), id = string(item.id);
        if (id && ids.has(id)) continue;
        if (id) ids.add(id);
        items.push(item);
      }
      cursor = string(page.nextCursor);
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    } while (items.length < 2000);
    return { messages: items.reverse().map(item => this.message_from_item(item)).filter((message): message is chat_message => !!message), truncated: !!cursor };
  }

  /**
   * @brief Restores a saved thread, its project directory and any active turn state.
   * @param id Valid persisted conversation identifier from the history index.
   * @param directories Optional explicit project roots, including [] for projectless restoration.
   * @returns After history hydration and replay of buffered current-thread notifications.
   * @throws Error On invalid, conflicting, unavailable-directory or failed protocol operations.
   * @note Unsupported pagination falls back to stable thread/read with at most 2000 displayed items.
   * Without an explicit project, restoration uses only the historical primary directory.
   */
  async resume(id: string, directories?: string[]): Promise<void> {
    if (!this.state.connected || !this.idle() || this.state.login_pending || !/^[\w-]{1,200}$/.test(id)) {
      const message = '当前无法恢复此会话，请检查连接并等待当前操作完成。';
      this.notice(message); throw new Error(message);
    }
    this.clear_queue('正在恢复会话，原会话的待发送消息已取消。');
    const generation = this.generation, sequence = ++this.operation_sequence;
    this.state.session_loading = true; this.state.error = ''; this.state.status = '正在恢复会话…';
    this.resuming_thread = id; this.resume_events = []; this.publish();
    try {
      let roots: string[];
      if (directories !== undefined) roots = await this.validate_directories(directories);
      else {
        let historical_cwd = this.session_directories.get(id);
        if (historical_cwd === undefined) {
          const stored = await this.request('thread/read', { threadId: id, includeTurns: false });
          historical_cwd = string(object(stored.thread).cwd);
        }
        roots = !historical_cwd || this.is_empty_workspace(historical_cwd) ? [] : await this.validate_directories([historical_cwd]);
      }
      const cwd = roots[0] || this.empty_workspace;
      const response = await this.request('thread/resume', { ...this.thread_options(cwd, roots), threadId: id, excludeTurns: true });
      const returned_id = string(object(response.thread).id);
      if (!returned_id || returned_id !== id) throw new Error('服务返回的会话编号无效。');
      const pages = await Promise.allSettled([
        this.history(id), this.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }),
      ]);
      let history: { messages: chat_message[]; truncated: boolean }, latest_turn: object_value;
      if (pages[0].status === 'fulfilled' && pages[1].status === 'fulfilled') {
        history = pages[0].value; latest_turn = object(array(pages[1].value.data)[0]);
      } else {
        for (const page of pages) if (page.status === 'rejected' && (!(page.reason instanceof rpc_failure) || page.reason.kind !== 'rpc')) throw page.reason;
        /// Some stores expose pagination methods but cannot page legacy history.
        /// Fall back to the stable full-history read for those RPC rejections.
        const stable = await this.request('thread/read', { threadId: id, includeTurns: true });
        const turns = array(object(stable.thread).turns);
        const items = turns.flatMap(turn => array(object(turn).items));
        history = { messages: items.slice(-2000).map(item => this.message_from_item(item)).filter((message): message is chat_message => !!message), truncated: items.length > 2000 };
        latest_turn = object(turns.at(-1));
      }
      const restored_cwd = string(response.cwd) || cwd;
      /// A named project's current roots may differ from its historical cwd.
      /// Preserve the explicit selection; every following turn reapplies it.
      const restored_roots = directories !== undefined ? roots : this.is_empty_workspace(restored_cwd) ? [] : await this.validate_directories([restored_cwd]);
      if (generation !== this.generation || sequence !== this.operation_sequence) throw new Error('会话恢复已被其他操作取消。');
      this.state.thread_id = id;
      this.state.cwd = restored_roots[0] || '';
      this.state.workspace_roots = restored_roots;
      if (!this.state.cwd) this.state.mode = 'read-only';
      this.state.messages = history.messages; this.state.diff = ''; this.item_details.clear();
      if (history.truncated) this.system('已加载最近 2000 项历史；更早记录仍保存在本机会话中。');
      this.state.busy = latest_turn.status === 'inProgress'; this.state.stopping = false;
      this.turn_id = this.state.busy ? string(latest_turn.id) : ''; this.interrupted_turn_id = '';
      if (this.state.models.some(model => model.id === response.model)) this.state.model = string(response.model);
      this.state.session_loading = false; this.state.status = this.state.busy ? '会话已恢复 · 正在回复…' : '会话已恢复';
      this.resuming_thread = '';
      const buffered = this.resume_events; this.resume_events = [];
      for (const event of buffered) this.notification(event);
      this.publish();
    } catch (error) {
      this.resuming_thread = ''; this.resume_events = [];
      if (sequence === this.operation_sequence) await this.operation_failure(error, generation);
      throw error;
    }
  }

  /**
   * @brief Validates server-initiated approvals and presents explicit one-time decisions.
   * @param message JSON-RPC request with its original string or numeric server ID.
   * @returns Immediately; stale or incomplete approvals are declined and unsupported methods rejected.
   */
  private server_request(message: object_value): void {
    const method = string(message.method), params = object(message.params), rpc_id = message.id;
    if (typeof rpc_id !== 'string' && typeof rpc_id !== 'number') return;
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      this.write({ id: rpc_id, error: { code: -32601, message: 'This client does not support this interactive request.' } });
      this.system(`当前客户端尚不支持此交互：${method}`); this.publish(); return;
    }
    const thread_id = string(params.threadId), turn_id = string(params.turnId);
    if (!this.state.busy || thread_id !== this.state.thread_id || (this.turn_id && turn_id && turn_id !== this.turn_id) || this.state.stopping) {
      this.write({ id: rpc_id, result: { decision: 'decline' } }); return;
    }
    const command = method === 'item/commandExecution/requestApproval';
    const title = command ? '允许执行此命令？' : '允许修改这些文件？';
    const detail = [command ? string(params.command) : this.item_details.get(string(params.itemId)) || '服务尚未提供文件修改详情。',
      params.cwd ? `目录：${string(params.cwd)}` : '', params.reason ? `原因：${string(params.reason)}` : '',
      params.grantRoot ? `授权目录：${string(params.grantRoot)}` : '',
      params.networkApprovalContext ? `网络访问：${JSON.stringify(params.networkApprovalContext)}` : '',
      params.additionalPermissions ? `额外权限：${JSON.stringify(params.additionalPermissions)}` : '',
    ].filter(Boolean).join('\n\n');
    if (detail.length > 14_000 || (!command && !this.item_details.has(string(params.itemId)))) {
      this.write({ id: rpc_id, result: { decision: 'decline' } });
      this.system('操作详情不完整或过长，已拒绝执行。请让智能体缩小操作范围。'); this.publish(); return;
    }
    const id = randomUUID();
    const decisions = array(params.availableDecisions);
    this.approvals.set(id, { rpc_id, thread_id, turn_id, generation: this.generation,
      can_accept: !has(params, 'availableDecisions') || params.availableDecisions == null || decisions.includes('accept') });
    this.options.emit({ type: 'approval', approval: { id, title, detail } });
  }

  /**
   * @brief Answers one pending UI approval after rechecking connection and turn ownership.
   * @param id Opaque application approval ID, distinct from the server's RPC ID.
   * @param accept True for explicit acceptance; false for decline.
   * @returns After queuing the decision or disconnecting when delivery fails.
   * @note Stale or unsupported acceptance is sent as decline; each approval is consumed once.
   */
  async approve(id: string, accept: boolean): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval) return;
    this.approvals.delete(id);
    if (approval.generation !== this.generation || !this.state.connected) return;
    const allowed = accept && approval.can_accept && this.state.busy && !this.state.stopping &&
      approval.thread_id === this.state.thread_id && (!this.turn_id || !approval.turn_id || approval.turn_id === this.turn_id);
    if (!this.write({ id: approval.rpc_id, result: { decision: allowed ? 'accept' : 'decline' } }))
      await this.disconnect('审批结果无法送达，连接已停止。');
  }

  /**
   * @brief Routes parsed responses, approvals and notifications to their owners.
   * @param message Valid JSON object decoded from one complete stdout frame.
   * @returns Immediately; history notifications are bounded and buffered during restoration.
   */
  private receive(message: object_value): void {
    if (has(message, 'method') && has(message, 'id')) { this.server_request(message); return; }
    if (has(message, 'id')) {
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (has(message, 'error')) entry.reject(new rpc_failure(entry.method, 'rpc', `${entry.method}：${string(object(message.error).message, '服务拒绝了此请求').slice(0, 4000)}`));
      else if (has(message, 'result')) entry.resolve(object(message.result));
      else entry.reject(new rpc_failure(entry.method, 'rpc', `${entry.method}：响应缺少结果`));
      return;
    }
    const params = object(message.params);
    if (this.resuming_thread && string(params.threadId) === this.resuming_thread &&
      (string(message.method).startsWith('item/') || string(message.method).startsWith('turn/') || message.method === 'error')) {
      if (this.resume_events.length < 10_000) this.resume_events.push(message);
      else void this.disconnect('恢复期间的消息过多，请重新打开会话。');
      return;
    }
    this.notification(message);
  }

  /**
   * @brief Applies current account or turn notifications while ignoring stale turn IDs.
   * @param message Server notification retaining official protocol method and property names.
   * @returns Immediately; terminal turn events alone clear normal generation busy state.
   */
  private notification(message: object_value): void {
    const method = string(message.method), params = object(message.params);
    if (method === 'account/login/completed') {
      if (!this.state.login_pending || (this.login_id && string(params.loginId) && params.loginId !== this.login_id)) return;
      ++this.login_sequence; this.state.login_pending = false; this.login_id = ''; this.close_login_window();
      if (bool(params.success)) { this.state.error = ''; void this.refresh(); }
      else this.notice(`登录未完成：${string(params.error, '已取消')}`);
      this.publish(); return;
    }
    if (method === 'account/updated') { if (this.state.connected) void this.refresh(); return; }
    if (method === 'account/rateLimits/updated') { if (this.state.authenticated) this.update_quota(params); return; }
    if (string(params.threadId) !== this.state.thread_id || !this.state.thread_id) return;
    const event_turn = string(params.turnId, string(object(params.turn).id));
    if (event_turn && this.finished_turns.has(event_turn)) return;
    if (this.turn_id && event_turn && event_turn !== this.turn_id) return;
    if (!this.state.busy) return;
    if (method === 'turn/started') {
      this.turn_id = string(object(params.turn).id);
      if (this.state.stopping) {
        const generation = this.generation, sequence = this.operation_sequence;
        void this.interrupt_turn().catch(error => sequence === this.operation_sequence ? this.operation_failure(error, generation) : undefined);
      }
      else this.state.status = '正在思考…';
      this.publish(); return;
    }
    if (method === 'item/agentMessage/delta') {
      const id = string(params.itemId); if (!id) return;
      let message = this.state.messages.find(entry => entry.role === 'assistant' && entry.id === id);
      if (!message) { message = { id, role: 'assistant', text: '' }; this.state.messages.push(message); }
      message.text = (message.text + string(params.delta)).slice(0, text_limit);
      this.state.status = this.state.stopping ? '正在停止回复…' : '正在回复…'; this.publish(true); return;
    }
    if (method === 'turn/diff/updated') { this.state.diff = string(params.diff).slice(0, text_limit); this.publish(true); return; }
    if (method === 'item/commandExecution/outputDelta') {
      const item = this.state.messages.find(entry => entry.role === 'tool' && entry.id === params.itemId);
      if (item) item.text = (item.text + string(params.delta)).slice(0, 20_000);
      this.publish(true); return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item), id = string(item.id), type = string(item.type);
      if (type === 'fileChange') { const diff = this.file_diff(item); this.item_details.set(id, diff); this.state.diff = diff; }
      if (type === 'agentMessage' && method !== 'item/completed') return;
      /// The submitted user message is already displayed optimistically.
      if (type === 'userMessage') return;
      const mapped = this.message_from_item(item);
      if (mapped) {
        const existing = this.state.messages.find(entry => entry.id === mapped.id && entry.role === mapped.role);
        if (existing) existing.text = mapped.text; else this.state.messages.push(mapped);
      }
      if (type === 'commandExecution' && method === 'item/started' && !this.state.stopping) this.state.status = '正在执行命令…';
      this.publish(true); return;
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (event_turn) this.finished_turns.add(event_turn);
      if (this.finished_turns.size > 256) this.finished_turns.delete(this.finished_turns.values().next().value!);
      this.state.busy = false; this.state.stopping = false; this.turn_id = ''; this.interrupted_turn_id = ''; this.approvals.clear();
      const status = string(turn.status);
      if (status !== 'completed') this.queue_paused = true;
      this.settle_replacement(status);
      if (turn.status === 'failed') {
        const error = string(object(turn.error).message, '未知错误'); this.state.status = `回复失败：${error}`; this.state.error = error;
      } else this.state.status = turn.status === 'interrupted' ? '已停止生成' : '回复完成';
      if (this.queue_paused && this.state.queued_messages?.length) this.state.status += ' · 待发送队列已暂停';
      this.publish();
      const generation = this.generation;
      void this.list_sessions().catch(error => { if (generation === this.generation) this.notice(error_text(error)); });
      if (this.state.authenticated) void this.read_quota();
      if (status === 'completed') void this.drain_queue();
      return;
    }
    if (method === 'error') {
      if (bool(params.willRetry)) this.state.status = '连接暂时中断，Codex 正在重试…';
      else this.state.error = string(object(params.error).message, '服务报告了错误');
      /// Only turn/completed owns the normal busy-to-idle transition; a nonfatal
      /// error notification must leave an active turn marked as running.
      this.publish();
    }
  }

  /**
   * @brief Stops callbacks, cancels outstanding work and shuts down every owned child.
   * @returns The shared disposal promise, including shutdowns started by earlier disconnects.
   * @note Repeated calls are idempotent and no state events are emitted after disposal starts.
   */
  async dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    if (this.publish_timer) { clearTimeout(this.publish_timer); this.publish_timer = undefined; }
    this.close_login_window();
    this.closing = (async () => {
      await this.disconnect('应用已关闭。');
      /// Transport errors detach a child before its asynchronous termination
      /// finishes, so disposal also waits for previously detached processes.
      await Promise.allSettled([...this.terminating]);
    })();
    return this.closing;
  }
}
