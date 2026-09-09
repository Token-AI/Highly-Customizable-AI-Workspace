/**
 * @file main.ts
 * @brief 管理本地桌面窗口、隔离的官方登录视图及主进程 IPC 安全边界。
 */

import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, clipboard, nativeTheme, desktopCapturer, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codex_backend } from './backend';
import { file_system_service } from './filesystem';
import { create_auth_policy } from './auth_policy';
import { auth_theme_css, supports_auth_theme } from './auth_theme';
import { avatar_crop, read_avatar_file } from './avatar';
import { project_store, project_directories } from './projects';
import { side_chat_launcher, wait_for_side_chat_bootstrap, type side_chat_handoff } from './side_chat';
import type { app_action, app_event, app_state } from '../shared/types';

const args = process.argv.slice(1);
const side_chat = args.includes('--side-chat');
const standard_user_data = app.getPath('userData');
/// 在 userData 隔离之前固定账号工作目录；侧边窗口沿用本应用账号，但不共享 UI 配置。
const subscription_home = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ai-code', 'codex');
const side_handoff_promise = side_chat ? wait_for_side_chat_bootstrap().catch(() => null) : null;
const side_launcher = new side_chat_launcher({ executable_path: process.execPath, application_path: app.getAppPath(), packaged: app.isPackaged });
let side_initializing = side_chat;
let side_pending_draft = '';
let side_draft_received = false;
let side_draft_delivered: (() => void) | null = null;
/**
 * @brief 读取命令行选项后的单个非选项值。
 * @param name 选项名称，含双短横线前缀。
 * @returns 选项值；不存在或紧跟另一个选项时为 undefined。
 */
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}
const screenshot = argument('--screenshot');
const smoke = args.includes('--smoke');
const auth_smoke = args.includes('--auth-smoke');
const side_chat_smoke = side_chat && args.includes('--preview') && args.includes('--side-chat-smoke');
const preview = !auth_smoke && (args.includes('--preview') || (!side_chat && (Boolean(screenshot) || args.includes('--screenshot-demo') || smoke)));
const demo = args.includes('--screenshot-demo') || smoke;
let response_smoke_enabled = false;
let response_smoke_reject = false;
let response_smoke_thread_start = false;
let response_smoke_gate: Promise<void> | null = null;
const response_smoke_actions: { type: string; text?: string; id?: string }[] = [];
const renderer_file = path.resolve(__dirname, '../renderer/index.html');
const preload_file = path.resolve(__dirname, 'preload.js');
let main_window: BrowserWindow | null = null;
let auth_window: BrowserWindow | null = null;
let auth_view: WebContentsView | null = null;
let auth_origin = '';
let auth_error = '';
let backend: codex_backend | null = null;
let files = new file_system_service();
let projects: project_store | null = null;
let active_project_id = '';
let project_error = '';
let project_operation = false;
let project_visible_state: app_state | null = null;
let project_mapping_timer: ReturnType<typeof setTimeout> | undefined;
const project_pending_events: app_event[] = [];
let closing_confirmed = false;
const programmatic_login_closures = new WeakSet<BrowserWindow>();
let quitting = false;
let disposal: Promise<void> | null = null;
let auth_smoke_loaded: ((origin: string) => void) | null = null;
let auth_load_status = 'not-started';
let auth_load_error_code: number | null = null;
let auth_last_origin = '';
let auth_last_title = '';
let auth_theme_ready: Promise<void> = Promise.resolve();
let auth_theme_status = 'not-applied';

let offline_state: app_state = {
  connected: demo, connecting: false, authenticated: demo, login_pending: false,
  busy: false, stopping: false, session_loading: false, preview: true,
  account: demo ? '演示账户' : '未登录 ChatGPT', quota: demo ? '离线界面演示' : '登录后查看订阅额度',
  status: demo ? '离线界面演示 · 未连接服务' : '预览模式 · 未启动后台服务', error: '',
  cwd: '', workspace_roots: [], model: '', mode: 'read-only', models: [], thread_id: '', messages: [], sessions: [], diff: '',
};
if (demo) {
  offline_state = { ...offline_state, thread_id: 'demo', messages: [
    { id: 'demo-user', role: 'user', text: '请帮我检查这个 Electron + TypeScript 项目的目录结构，并说明下一步如何构建。' },
    { id: 'demo-assistant', role: 'assistant', text: '项目由 Electron 主进程和 TypeScript 界面组成。\n\n1. 在 VS Code 中打开项目文件夹。\n2. 安装项目声明的开发依赖。\n3. 构建并启动桌面客户端。\n\n```powershell\nnpm run build\nnpm start\n```\n\n左侧可以浏览项目文件；双击文本文件会打开只读预览。' },
  ], sessions: [{ id: 'demo', title: '检查 Electron 项目结构' }] };
}

/**
 * @brief 获取真实后端或离线预览的当前状态。
 * @returns 当前状态对象，供受限 IPC 和本地界面事件使用。
 */
function state(): app_state { return project_visible_state ?? project_state(backend?.state ?? offline_state); }

/** @brief 读取后端多根配置，兼容未提供新字段的旧状态。 */
function workspace_roots(value: app_state): string[] { return value.workspace_roots ? [...value.workspace_roots] : value.cwd ? [value.cwd] : []; }

/** @brief 按当前平台路径语义比较有序目录列表，不扩大目录边界。 */
function same_roots(left: string[], right: string[]): boolean {
  const key = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return left.length === right.length && left.every((value, index) => key(value) === key(right[index]));
}

/** @brief 将后端快照与主进程项目元数据合并；该函数没有写入副作用。 */
function project_state(value: app_state): app_state {
  const roots = workspace_roots(value);
  const selected = projects?.find(active_project_id);
  const error = project_error && !value.error.includes(project_error) ? [value.error, project_error].filter(Boolean).join('\n') : value.error;
  return { ...value, cwd: roots[0] ?? '', workspace_roots: roots, project_catalog: projects?.catalog ?? [],
    active_project_id: selected && same_roots(selected.directories, roots) ? selected.id : '', error };
}

/** @brief 仅在最终会话及项目目录一致时记录归属，并合并频繁状态事件中的写入。 */
function remember_project_thread(value: app_state): void {
  if (!projects || project_operation || value.session_loading || !value.thread_id || !value.active_project_id) return;
  if (!projects.remember_thread(value.thread_id, value.active_project_id)) return;
  if (project_mapping_timer) clearTimeout(project_mapping_timer);
  project_mapping_timer = setTimeout(() => {
    project_mapping_timer = undefined;
    void projects?.flush().catch(error => {
      project_error = error instanceof Error ? error.message : '会话项目归属保存失败。';
      emit({ type: 'state', state: backend?.state ?? offline_state });
    });
  }, 250);
}

/**
 * @brief 仅向仍存活的主窗口发送应用事件。
 * @param event 共享协议定义的状态、审批或窗口事件。
 */
function emit(event: app_event, force = false): void {
  if (project_operation && !force) {
    if (event.type !== 'state') project_pending_events.push(event);
    return;
  }
  if (event.type === 'state') {
    event = { type: 'state', state: project_visible_state ?? project_state(event.state) };
    if (!project_operation) remember_project_thread(event.state);
  }
  if (main_window && !main_window.isDestroyed()) main_window.webContents.send('ai-code:event', event);
}
/** @brief 向本地认证壳发送 origin 与安全错误提示，不包含授权查询参数。 */
function emit_auth(): void {
  if (auth_window && !auth_window.isDestroyed()) {
    auth_window.webContents.send('ai-code:event', { type: 'auth', origin: auth_origin, ...(auth_error ? { error: auth_error } : {}) } satisfies app_event);
  }
}
/**
 * @brief 检查 URL 是否精确指向打包后的本地界面入口。
 * @param value 待验证的页面地址。
 * @returns 是否属于允许的本地 file 页面。
 */
function safe_local_url(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === renderer_file; }
  catch { return false; }
}

/**
 * @brief 禁止本地界面跳出应用或创建 webview，并同步窗口最大化状态。
 * @param window 主窗口或本地认证壳。
 */
function configure_local_window(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!safe_local_url(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const update_window_state = (): void => {
    if (!window.isDestroyed()) window.webContents.send('ai-code:event', { type: 'window', maximized: window.isMaximized() } satisfies app_event);
  };
  window.on('maximize', update_window_state);
  window.on('unmaximize', update_window_state);
}

/** @brief 程序化销毁认证视图，避免 closed 回调误取消后续登录请求。 */
function close_login(): void {
  const view = auth_view;
  const window = auth_window;
  auth_view = null;
  auth_window = null;
  if (window) programmatic_login_closures.add(window);
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  if (window && !window.isDestroyed()) window.destroy();
  auth_origin = '';
  auth_error = '';
}

/**
 * @brief 创建无 Node/preload 的隔离认证视图及本地自定义标题栏。
 * @param url 官方后端返回的初始授权 URL，仅用于加载而不写入日志。
 * @param load_remote false 仅供离线 UI 自检，不加载官方页面。
 * @returns 本地壳加载完成且认证视图已创建后的 Promise。
 * @throws Error 初始 URL 不合法、窗口创建失败或本地壳无法加载。
 */
async function open_login(url: string, load_remote = true): Promise<void> {
  const policy = create_auth_policy(url);
  close_login();
  const authentication = session.fromPartition('persist:ai-code-auth');
  authentication.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  authentication.setPermissionCheckHandler(() => false);
  authentication.removeAllListeners('will-download');
  authentication.on('will-download', event => event.preventDefault());
  authentication.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const target = new URL(details.url);
      allowed = target.protocol === 'https:' && policy.evaluate(details.url).allowed;
      if (details.resourceType === 'mainFrame') allowed = policy.evaluate(details.url).allowed;
      else if (target.protocol === 'data:' || target.protocol === 'blob:') allowed = true;
      if (!load_remote && details.url === 'about:blank') allowed = true;
    } catch { /* Reject malformed and unsupported URLs. */ }
    callback({ cancel: !allowed });
  });
  const window = new BrowserWindow({
    width: 660, height: 820, minWidth: 520, minHeight: 640,
    title: '连接 ChatGPT · AI Code', frame: false, show: false, backgroundColor: '#ffffff',
    maximizable: false, fullscreenable: false,
    ...(main_window && !main_window.isDestroyed() ? { parent: main_window, modal: true } : {}),
    webPreferences: { preload: preload_file, partition: 'persist:ai-code-ui', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  auth_window = window;
  auth_origin = new URL(policy.initial_url).origin;
  auth_error = '';
  auth_last_origin = auth_origin;
  auth_last_title = '';
  auth_load_status = load_remote ? 'loading' : 'offline-shell';
  auth_load_error_code = null;
  auth_theme_status = 'not-applied';
  auth_theme_ready = Promise.resolve();
  configure_local_window(window);
  const view = new WebContentsView({ webPreferences: {
    session: authentication, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
    allowRunningInsecureContent: false, navigateOnDragDrop: false,
  } });
  auth_view = view;
  view.setBackgroundColor('#ffffff');
  window.contentView.addChildView(view);
  const layout = (): void => {
    if (window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    view.setBounds({ x: 16, y: 150, width: Math.max(0, width - 32), height: Math.max(0, height - 186) });
  };
  window.on('resize', layout);
  /**
   * @brief 阻止不允许的主页面跳转，并将原因显示在本地认证壳。
   * @param event 可取消的 Electron 导航事件。
   * @param target 目标完整 URL，不直接发送到界面。
   */
  const navigate = (event: Electron.Event, target: string): void => {
    const decision = policy.evaluate(target);
    if (!decision.allowed) {
      event.preventDefault();
      auth_error = decision.error ?? '已阻止不安全的登录跳转。';
    } else { auth_origin = decision.origin; auth_error = ''; }
    emit_auth();
  };
  view.webContents.on('will-navigate', navigate);
  view.webContents.on('will-redirect', event => {
    if (event.isMainFrame) navigate(event, event.url);
  });
  view.webContents.on('dom-ready', () => {
    const source_url = view.webContents.getURL();
    if (!supports_auth_theme(source_url)) { auth_theme_status = 'unsupported-origin'; return; }
    /// 仅向已验证的官方顶层页面插入固定外观 CSS；表单及认证事件保持原样。
    auth_theme_ready = view.webContents.insertCSS(auth_theme_css).then(async key => {
      if (view.webContents.isDestroyed()) return;
      if (view.webContents.getURL() !== source_url) {
        await view.webContents.removeInsertedCSS(key).catch(() => undefined);
        return;
      }
      auth_theme_status = 'applied';
    }).catch(() => { auth_theme_status = 'failed'; });
  });
  view.webContents.on('did-navigate', (_event, target) => {
    const decision = policy.evaluate(target);
    if (decision.allowed) { auth_origin = decision.origin; auth_last_origin = decision.origin; auth_error = ''; emit_auth(); }
  });
  view.webContents.on('did-finish-load', () => {
    if (view.webContents.isDestroyed()) return;
    auth_load_status = 'finished';
    auth_last_title = safe_auth_title(view.webContents.getTitle());
    if (!auth_smoke_loaded) return;
    const target = view.webContents.getURL();
    const decision = policy.evaluate(target);
    if (decision.allowed && target.startsWith('https:') && view.webContents.getTitle().trim()) auth_smoke_loaded(decision.origin);
  });
  view.webContents.on('did-fail-load', (_event, code, _description, _url, main_frame) => {
    if (code === -3 || !main_frame || window.isDestroyed()) return;
    auth_load_status = 'failed';
    auth_load_error_code = code;
    auth_error = '登录页面未能加载。可以重新尝试登录，或取消本次操作。';
    emit_auth();
  });
  view.webContents.on('will-attach-webview', event => event.preventDefault());
  view.webContents.setWindowOpenHandler(({ url: target, postBody }) => {
    const decision = policy.evaluate(target);
    if (decision.allowed) {
      if (postBody) {
        /// 只判断是否存在 POST，不读取表单数据，也不将认证 POST 改成 GET。
        auth_error = '此登录方式需要单独的认证窗口。请返回官方登录页，或取消后重试并选择邮箱登录。';
        emit_auth();
        return { action: 'deny' };
      }
      auth_origin = decision.origin; auth_error = ''; emit_auth();
      void view.webContents.loadURL(target).catch(() => {
        if (!window.isDestroyed()) { auth_error = '登录页面未能加载，请重试。'; emit_auth(); }
      });
    } else { auth_error = decision.error ?? '已阻止不安全的登录跳转。'; emit_auth(); }
    return { action: 'deny' };
  });
  window.on('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (auth_window === window) { auth_window = null; auth_view = null; }
    if (!programmatic_login_closures.has(window)) void backend?.cancel_login().catch(() => undefined);
  });
  await window.loadFile(renderer_file, { query: { auth: '1' } });
  layout();
  window.show();
  emit_auth();
  if (load_remote) {
    void view.webContents.loadURL(policy.initial_url).catch(() => {
      if (!window.isDestroyed()) { auth_load_status = 'failed'; auth_error = '登录页面未能加载，请重试。'; emit_auth(); }
    });
  }
}

/**
 * @brief 移除页面标题中的 URL、查询内容和疑似长令牌，供登录自检诊断使用。
 * @param value Chromium 返回的远端页面标题。
 * @returns 不含控制字符且长度受限的诊断标题。
 */
function safe_auth_title(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, '[URL omitted]')
    .replace(/[?#].*$/su, '')
    .replace(/\b(?:access_token|refresh_token|id_token|authorization|state|code)\s*[:=]\s*\S+/giu, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]+)*\b/gu, '[redacted]')
    .trim().slice(0, 200);
}

/**
 * @brief 为自检中的浏览器操作设置截止，避免渲染进程无响应阻止诊断落盘。
 * @param operation 已开始的异步操作；超时后仍观察其结果，避免未处理拒绝。
 * @param milliseconds 最长等待毫秒数。
 * @returns 截止前完成的操作结果。
 * @throws Error 操作失败或超过截止；错误详情不会直接写入认证日志。
 */
async function diagnostic_deadline<result_type>(operation: Promise<result_type>, milliseconds: number): Promise<result_type> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Authentication diagnostic operation timed out.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * @brief 保存当前认证壳、远端页面截图及经过删减的登录加载诊断。
 * @param outcome 本次测试的 passed 或 failed 状态。
 * @param started 测试开始时间戳，用于计算耗时。
 * @returns 诊断 JSON 的绝对路径；截图不可用时仍尽量保留状态文件。
 * @throws Error 诊断输出目录或 JSON 文件无法写入。
 */
async function save_auth_diagnostics(outcome: 'passed' | 'failed', started: number): Promise<string> {
  const output = path.resolve(screenshot || `build/auth-smoke-${outcome}.png`);
  const filename = path.parse(output);
  const page_output = path.join(filename.dir, `${filename.name}-login-page.png`);
  const window_output = path.join(filename.dir, `${filename.name}-window.png`);
  const diagnostics_output = path.join(filename.dir, `${filename.name}-diagnostics.json`);
  await fs.mkdir(filename.dir, { recursive: true });
  const captures: { shell: string; page: string; window: string; errors: string[] } = { shell: '', page: '', window: '', errors: [] };
  const window = auth_window;
  const view = auth_view;
  let loading = false;
  const write_diagnostics = async (capture_status: 'collecting' | 'complete'): Promise<void> => {
    const current = state();
    await fs.writeFile(diagnostics_output, JSON.stringify({
      outcome, elapsed_seconds: Math.round((Date.now() - started) / 1000), capture_status,
      origin: auth_last_origin, title: auth_last_title, loading, load_status: auth_load_status,
      load_error_code: auth_load_error_code, load_error: auth_error, theme_status: auth_theme_status,
      backend: { connected: current.connected, connecting: current.connecting, login_pending: current.login_pending },
      captures,
    }, null, 2), 'utf8');
  };
  /// 先保存基本状态，主题或任一截图失败时仍有可检查的诊断文件。
  await write_diagnostics('collecting');
  try { await diagnostic_deadline(auth_theme_ready, 2_000); }
  catch { captures.errors.push('Authentication theme not ready within 2 seconds.'); }
  if (window && !window.isDestroyed()) {
    try {
      await diagnostic_deadline((async () => {
        await fs.writeFile(output, (await window.webContents.capturePage()).toPNG());
      })(), 3_000);
      captures.shell = output;
    } catch { captures.errors.push('Authentication shell screenshot unavailable or exceeded 3 seconds.'); }
  } else captures.errors.push('Authentication shell is not open.');
  if (view && !view.webContents.isDestroyed()) {
    try {
      loading = view.webContents.isLoading();
      auth_last_title = safe_auth_title(view.webContents.getTitle());
      const target = new URL(view.webContents.getURL());
      if (target.protocol === 'https:' || target.protocol === 'http:') auth_last_origin = target.origin;
    } catch { captures.errors.push('Authentication page metadata unavailable.'); }
    try {
      await diagnostic_deadline((async () => {
        await fs.writeFile(page_output, (await view.webContents.capturePage()).toPNG());
      })(), 3_000);
      captures.page = page_output;
    } catch { captures.errors.push('Authentication page screenshot unavailable or exceeded 3 seconds.'); }
  } else captures.errors.push('Authentication view is not open.');
  if (window && !window.isDestroyed()) {
    try {
      const source_id = window.getMediaSourceId();
      const bounds = window.getBounds();
      await diagnostic_deadline((async () => {
        const sources = await desktopCapturer.getSources({
          types: ['window'], fetchWindowIcons: false,
          thumbnailSize: { width: Math.min(bounds.width * 2, 2400), height: Math.min(bounds.height * 2, 2400) },
        });
        /// 仅保存当前应用登录窗的匹配图像，不输出其他窗口的名称或内容。
        const source = sources.find(candidate => candidate.id === source_id);
        if (!source || source.thumbnail.isEmpty()) throw new Error('Authentication window image unavailable.');
        await fs.writeFile(window_output, source.thumbnail.toPNG());
      })(), 5_000);
      captures.window = window_output;
    } catch { captures.errors.push('Authentication full-window screenshot unavailable or exceeded 5 seconds.'); }
  } else captures.errors.push('Authentication full-window screenshot unavailable because the window is closed.');
  await write_diagnostics('complete');
  return diagnostics_output;
}

/**
 * @brief 校验 IPC 字符串类型、长度及 NUL 字符。
 * @param value 不受信任的字段值。
 * @param maximum 允许的最大字符数。
 * @returns 已通过校验的字符串。
 * @throws Error 字段类型、长度或字符内容不合法。
 */
function string_field(value: unknown, maximum = 32767): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw new Error('请求参数无效。');
  return value;
}
/**
 * @brief 校验布尔参数，不接受 truthy 值隐式转换。
 * @param value 不受信任的字段值。
 * @returns 已验证的布尔值。
 * @throws Error 字段不是 boolean。
 */
function boolean_field(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('请求参数无效。');
  return value;
}
/**
 * @brief 将 IPC 来源限制为受管本地窗口的顶层 frame。
 * @param event Electron 提供的 IPC 调用元数据。
 * @returns 已验证的主窗口或认证壳；远端视图和子 frame 均不允许。
 * @throws Error 窗口、frame 或页面路径不属于信任范围。
 */
function sender_window(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const window = [main_window, auth_window].find(candidate => candidate && !candidate.isDestroyed() && candidate.webContents.id === event.sender.id);
  if (!window || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !safe_local_url(event.senderFrame.url)) {
    throw new Error('拒绝来自非本地应用页面的请求。');
  }
  return window;
}
/**
 * @brief 在历史会话切换项目后重新验证并同步文件读取边界。
 * @returns 文件服务与当前状态使用一致的已验证根目录。
 * @throws Error 历史路径无效、包含链接，或验证期间项目再次切换。
 */
async function ensure_project_root(): Promise<void> {
  const roots = workspace_roots(state());
  if (!roots.length) {
    files = new file_system_service();
    throw new Error('尚未打开项目目录，请先选择包含目录的项目。');
  }
  if (same_roots(roots, files.roots)) return;
  const candidate = new file_system_service();
  await candidate.set_roots(roots);
  if (!same_roots(workspace_roots(state()), roots)) throw new Error('项目已切换，请重试文件操作。');
  files = candidate;
}

/** @brief 获取已初始化的独立项目存储。 */
function project_storage(): project_store {
  if (!projects) throw new Error('项目配置尚未准备完成。');
  return projects;
}

/**
 * @brief 在项目操作期间冻结对外项目快照，最终只发布一致的目录及项目状态。
 * @param operation 已授权的项目保存、选择、删除或历史恢复步骤。
 * @returns 操作后的完整状态。
 * @throws Error 正在生成或加载、另一个项目操作未完成，或具体操作失败。
 */
async function project_transaction(operation: () => Promise<void>): Promise<app_state> {
  const current = state();
  if (project_operation || current.busy || current.session_loading || current.connecting || current.login_pending) throw new Error('请等待当前生成、加载或登录结束后再切换项目。');
  project_operation = true;
  project_visible_state = { ...current, session_loading: true, status: '正在更新项目…' };
  emit({ type: 'state', state: project_visible_state }, true);
  try {
    await operation();
    if (projects?.writable) project_error = '';
  } catch (error) {
    project_error = error instanceof Error ? error.message : '项目操作未完成。';
    throw error;
  } finally {
    project_visible_state = null;
    project_operation = false;
    emit({ type: 'state', state: backend?.state ?? offline_state });
    for (const event of project_pending_events.splice(0)) emit(event);
  }
  return state();
}

/** @brief 将已验证的独立目录同时提交给后端、文件服务及项目选择元数据。 */
async function activate_project(id: string, candidate: file_system_service): Promise<void> {
  const roots = candidate.roots;
  if (backend) {
    await backend.set_directories(roots);
    if (!same_roots(workspace_roots(backend.state), roots)) throw new Error('项目目录未能切换，请等待当前操作结束后重试。');
  } else {
    offline_state = { ...offline_state, cwd: roots[0] ?? '', workspace_roots: roots, thread_id: '', messages: [], diff: '',
      mode: roots.length ? offline_state.mode : 'read-only' };
  }
  files = candidate;
  active_project_id = id;
}

/** @brief 只在显式选择时验证已保存项目的所有目录；空编号退出当前项目。 */
async function choose_project(id: string): Promise<void> {
  const entry = id ? project_storage().find(id) : undefined;
  if (id && !entry) throw new Error('所选项目不存在。');
  const candidate = new file_system_service();
  await candidate.set_roots(entry?.directories ?? []);
  await activate_project(entry?.id ?? '', candidate);
}

/** @brief 兼容旧单目录入口，优先选择已有对应项目，否则保存 basename 项目。 */
async function choose_directory(directory: string): Promise<void> {
  const candidate = new file_system_service();
  await candidate.set_root(directory);
  const store = project_storage();
  const entry = store.match_directory(candidate.root) ?? await store.save_project(undefined,
    (path.basename(candidate.root) || path.parse(candidate.root).root || '项目').slice(0, 80), candidate.roots);
  await activate_project(entry.id, candidate);
}

/** @brief 恢复映射项目或旧单目录历史，禁止沿用上一个项目的附加目录。 */
async function resume_project_thread(id: string): Promise<void> {
  if (!backend) throw new Error('离线预览不能恢复服务端历史会话。');
  const store = project_storage();
  const mapped = store.for_thread(id);
  if (mapped) {
    const candidate = new file_system_service();
    const roots = await candidate.set_roots(mapped.directories);
    await activate_project(mapped.id, candidate);
    await backend.resume(id, roots);
  } else {
    await activate_project('', new file_system_service());
    await backend.resume(id);
  }
  if (backend.state.thread_id !== id) throw new Error('历史会话未能完成恢复。');
  const roots = workspace_roots(backend.state);
  const candidate = new file_system_service();
  await candidate.set_roots(roots);
  files = candidate;
  if (mapped && !same_roots(mapped.directories, roots)) throw new Error('恢复的会话目录与项目定义不一致。');
  active_project_id = mapped?.id ?? (roots.length === 1 ? store.match_directory(roots[0])?.id ?? '' : '');
}

/**
 * @brief 使用 Electron 原生解码器将本地头像转换为居中的 128×128 PNG。
 * @param value 用户明确选中的绝对本地图片路径，不受项目根目录限制。
 * @returns 仅包含缩放后 PNG 像素的 data URL，不返回原始文件或元数据。
 * @throws Error 文件边界检查失败、原生解码失败或图像转换失败。
 */
async function read_avatar(value: string): Promise<string> {
  const bytes = await read_avatar_file(value);
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) throw new Error('无法解码这张图片，请选择有效的 PNG 或 JPEG 图片。');
  const size = source.getSize();
  const result = source.crop(avatar_crop(size.width, size.height)).resize({ width: 128, height: 128, quality: 'best' });
  if (result.isEmpty()) throw new Error('头像图片转换失败，请选择其他图片。');
  return `data:image/png;base64,${result.toPNG().toString('base64')}`;
}

/**
 * @brief 在专用离线自检范围内记录真实 IPC 并模拟队列响应，不创建后台或模型请求。
 * @param action 本地测试窗口提交的动作。
 * @returns 是否由离线桩处理；普通预览与正常启动永远不使用此分支。
 */
async function stub_response_action(action: app_action): Promise<boolean> {
  if (!smoke || !response_smoke_enabled || backend) return false;
  if (action.type === 'send' || action.type === 'queue_message' || action.type === 'steer_message' || action.type === 'stop_and_send' || action.type === 'side_chat') {
    const text = string_field(action.text, 64_000);
    response_smoke_actions.push({ type: action.type, text });
    if (response_smoke_thread_start && action.type === 'stop_and_send') {
      response_smoke_thread_start = false;
      offline_state = { ...offline_state, thread_id: 'offline-started-thread', busy: false };
      emit({ type: 'state', state: offline_state });
      await new Promise(resolve => setTimeout(resolve, 20));
      offline_state = { ...offline_state, busy: true };
      emit({ type: 'state', state: offline_state });
    }
    if (response_smoke_gate) await response_smoke_gate;
    if (response_smoke_reject) { response_smoke_reject = false; throw new Error('离线自检：服务明确拒绝该消息。'); }
    if (action.type === 'queue_message') {
      offline_state = { ...offline_state, queued_messages: [...offline_state.queued_messages ?? [], { id: `offline-queue-${response_smoke_actions.length}`, text }] };
      emit({ type: 'state', state: offline_state });
    }
    return true;
  }
  if (action.type === 'remove_queued') {
    const id = string_field(action.id, 200);
    response_smoke_actions.push({ type: action.type, id });
    offline_state = { ...offline_state, queued_messages: offline_state.queued_messages?.filter(message => message.id !== id) };
    emit({ type: 'state', state: offline_state }); return true;
  }
  if (action.type === 'resume_queue') {
    response_smoke_actions.push({ type: action.type });
    offline_state = { ...offline_state, queued_messages: [] };
    emit({ type: 'state', state: offline_state }); return true;
  }
  return false;
}

/**
 * @brief 验证来源及动作参数后分发本地窗口、文件系统或后端操作。
 * @param event Electron 提供的调用来源。
 * @param value 渲染页面提交的未验证动作对象。
 * @returns 与共享动作协议对应的结果或 void。
 * @throws Error 来源、参数或权限不合法，或具体操作失败。
 */
async function invoke(event: Electron.IpcMainInvokeEvent, value: unknown): Promise<unknown> {
  const window = sender_window(event);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效。');
  const action = value as app_action;
  if (typeof action.type !== 'string') throw new Error('请求格式无效。');
  if (window === auth_window && !['ready', 'cancel_login', 'window'].includes(action.type)) throw new Error('登录窗口不允许执行项目操作。');
  if (side_initializing && !['ready', 'draft_ready', 'window', 'copy', 'read_avatar'].includes(action.type)) {
    throw new Error('侧边聊天正在接收消息，请稍候。');
  }
  if (project_operation && !['ready', 'window', 'copy', 'read_avatar', 'approve', 'stop', 'cancel_login'].includes(action.type)) {
    throw new Error('项目正在切换，请稍后再试。');
  }
  switch (action.type) {
    case 'ready':
      window.webContents.send('ai-code:event', { type: 'window', maximized: window.isMaximized() } satisfies app_event);
      if (window === auth_window) emit_auth();
      else if (side_pending_draft) emit({ type: 'draft', text: side_pending_draft, acknowledge: !side_draft_received });
      return state();
    case 'draft_ready': {
      const text = string_field(action.text, 64_000);
      if (!side_chat || !side_pending_draft || text !== side_pending_draft) throw new Error('此窗口没有匹配的侧边聊天交接。');
      side_draft_received = true;
      side_draft_delivered?.();
      return;
    }
    case 'window': {
      const command = string_field(action.command, 20);
      if (command === 'minimize') window.minimize();
      else if (command === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (command === 'close') {
        if (window === main_window) closing_confirmed = true;
        window.close();
      } else throw new Error('窗口操作无效。');
      return;
    }
    case 'list_directory': {
      const project_only = action.project_only === undefined ? false : boolean_field(action.project_only);
      if (project_only) await ensure_project_root();
      return files.list_directory(string_field(action.path), project_only);
    }
    case 'read_file': await ensure_project_root(); return files.read_file(string_field(action.path));
    case 'read_avatar': return read_avatar(string_field(action.path));
    case 'export_conversation': return files.export_conversation(string_field(action.path), boolean_field(action.overwrite), state().messages);
    case 'copy': clipboard.writeText(string_field(action.text, 2_000_000)); return;
    case 'set_project': return project_transaction(() => choose_directory(string_field(action.path)));
    case 'select_project': return project_transaction(() => choose_project(string_field(action.id, 80)));
    case 'save_project': return project_transaction(async () => {
      const directories = project_directories(action.directories);
      const candidate = new file_system_service();
      const roots = await candidate.set_roots(directories);
      const id = action.id === undefined ? undefined : string_field(action.id, 80);
      const entry = await project_storage().save_project(id, string_field(action.name, 80), roots);
      await activate_project(entry.id, candidate);
    });
    case 'delete_project': return project_transaction(async () => {
      const id = string_field(action.id, 80);
      await project_storage().delete_project(id);
      if (active_project_id === id) await activate_project('', new file_system_service());
    });
    case 'resume': return project_transaction(() => resume_project_thread(string_field(action.id, 200)));
    case 'cancel_login': if (backend) await backend.cancel_login(); else close_login(); return;
    default: break;
  }
  if (action.type === 'set_mode' && action.mode === 'workspace-write' && !state().cwd) {
    throw new Error('尚未打开项目，请先选择项目文件夹后再启用文件修改。');
  }
  if (!backend) {
    if (await stub_response_action(action)) return;
    if (action.type === 'new_chat') { offline_state = { ...offline_state, thread_id: '', messages: [], diff: '' }; emit({ type: 'state', state: offline_state }); return; }
    if (action.type === 'set_mode' && (action.mode === 'read-only' || action.mode === 'workspace-write')) {
      offline_state = { ...offline_state, mode: action.mode }; emit({ type: 'state', state: offline_state }); return;
    }
    throw new Error('当前为离线预览模式。正常启动客户端后可登录和发送消息。');
  }
  switch (action.type) {
    case 'connect': return backend.connect();
    case 'login': return backend.login();
    case 'logout':
      await backend.logout();
      if (backend.state.authenticated) throw new Error('当前无法退出账号，请停止当前操作后重试。');
      close_login();
      await session.fromPartition('persist:ai-code-auth').clearStorageData();
      await session.fromPartition('persist:ai-code-auth').clearCache();
      return;
    case 'refresh': return backend.refresh();
    case 'new_chat': return backend.new_chat();
    case 'send': {
      const text = string_field(action.text, 100_000);
      await backend.send(text);
      if (side_pending_draft && (text === side_pending_draft || text.startsWith(`${side_pending_draft}\n\n`))) {
        const delivered = side_pending_draft;
        side_pending_draft = '';
        emit({ type: 'draft_sent', text: delivered });
      }
      return;
    }
    case 'queue_message': return backend.enqueue(string_field(action.text, 100_000));
    case 'steer_message': return backend.steer(string_field(action.text, 100_000));
    case 'stop_and_send': return backend.stop_and_send(string_field(action.text, 100_000));
    case 'remove_queued': return backend.remove_queued(string_field(action.id, 1000));
    case 'resume_queue': return backend.resume_queue();
    case 'side_chat': {
      const current = state();
      const selected = projects?.find(current.active_project_id ?? '');
      return side_launcher.open_side_chat({ text: string_field(action.text, 64_000), roots: workspace_roots(current),
        ...(current.model ? { model: current.model } : {}),
        ...(selected ? { project_name: selected.name } : {}) });
    }
    case 'stop': return backend.stop();
    case 'set_model': return backend.set_model(string_field(action.id, 1000));
    case 'set_mode':
      if (action.mode !== 'read-only' && action.mode !== 'workspace-write') throw new Error('工作模式无效。');
      return backend.set_mode(action.mode);
    case 'approve': return backend.approve(string_field(action.id, 1000), boolean_field(action.accept));
    default: throw new Error('未知的应用操作。');
  }
}

/**
 * @brief 用临时合成图片及 .invalid 演示账号验证完整的本机头像交互。
 * @param window 已加载本地页面且使用隔离 userData 的离线自检窗口。
 * @returns 文件选择、三处图片显示、重载、账号隔离、恢复默认及窗口按钮检查完成后的 Promise。
 * @throws Error 任何 DOM 或原生窗口状态断言失败；每项 DOM 等待最多三秒。
 * @note 不读取真实图片或账号；finally 仅删除本测试创建的图片和两个头像存储项。
 */
async function run_avatar_smoke(window: BrowserWindow): Promise<void> {
  if (!smoke || backend || !state().preview || !safe_local_url(window.webContents.getURL())) {
    throw new Error('Avatar smoke requires an isolated local preview window.');
  }
  const previous_state = offline_state;
  const previous_maximized = window.isMaximized();
  const directory = app.getPath('userData');
  const fixture = path.join(directory, `avatar-smoke-${process.pid}.png`);
  let fixture_created = false;
  const first_email = 'avatar-primary@ui-smoke.invalid';
  const second_email = 'avatar-secondary@ui-smoke.invalid';
  const first_name = '头像自检演示账号 A';
  const second_name = '头像自检演示账号 B';
  const storage_keys = [first_email, second_email].map(email => `ai_code_avatar:account:${email}`);
  const targets = ['title-avatar', 'sidebar-avatar', 'profile-avatar'];
  const evaluate = (script: string): Promise<unknown> => diagnostic_deadline(window.webContents.executeJavaScript(script), 3_000);
  const wait_for = async (condition: string, message: string): Promise<void> => {
    await evaluate(`(async () => {
      const deadline = performance.now() + 2800;
      while (!(${condition})) {
        if (performance.now() >= deadline) throw new Error(${JSON.stringify(message)});
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })()`);
  };
  const pictures_loaded = (ids: string[], expected = ''): string => `${JSON.stringify(ids)}.every(id => {
    const image = document.querySelector('#' + id + ' img');
    return image && image.complete && image.naturalWidth === 128 && image.naturalHeight === 128
      && ${expected ? `image.src === ${JSON.stringify(expected)}` : "image.src.startsWith('data:image/png;base64,')"};
  })`;
  const default_pictures = `${JSON.stringify(targets)}.every(id => document.querySelector('#' + id + ' svg') && !document.querySelector('#' + id + ' img'))`;
  try {
    await fs.mkdir(directory, { recursive: true });
    const pixels = Buffer.alloc(48 * 32 * 4);
    for (let y = 0; y < 32; ++y) {
      for (let x = 0; x < 48; ++x) {
        const offset = (y * 48 + x) * 4;
        pixels[offset] = x < 24 ? 220 : 50;
        pixels[offset + 1] = 60 + y * 4;
        pixels[offset + 2] = x < 24 ? 60 : 220;
        pixels[offset + 3] = 255;
      }
    }
    const image = nativeImage.createFromBitmap(pixels, { width: 48, height: 32, scaleFactor: 1 });
    if (image.isEmpty()) throw new Error('Synthetic avatar fixture could not be created.');
    await fs.writeFile(fixture, image.toPNG(), { flag: 'wx' });
    fixture_created = true;
    await evaluate(`${JSON.stringify(storage_keys)}.forEach(key => localStorage.removeItem(key))`);
    offline_state = { ...previous_state, connected: true, authenticated: true, login_pending: false,
      busy: false, session_loading: false, cwd: '', workspace_roots: [], account: first_name, account_email: first_email };
    emit({ type: 'state', state: offline_state });
    await wait_for(`document.getElementById('account-name')?.textContent === ${JSON.stringify(first_name)}`, 'Synthetic avatar account was not rendered');
    await evaluate(`document.getElementById('title-account').click()`);
    await wait_for(`document.querySelector('.account-dialog') && document.getElementById('choose-avatar')`, 'Title account control did not open the custom profile dialog');
    await evaluate(`document.getElementById('choose-avatar').click()`);
    await wait_for(`document.querySelector('.path-dialog .path-input')?.value === ''`, 'Avatar picker must start without opening a project');
    await evaluate(`(() => {
      const input = document.querySelector('.path-dialog .path-input');
      input.value = ${JSON.stringify(directory)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await wait_for(`Array.from(document.querySelectorAll('.path-row')).some(row => row.title === ${JSON.stringify(fixture)})`, 'Avatar fixture did not appear in the custom file picker');
    await evaluate(`(() => {
      Array.from(document.querySelectorAll('.path-row')).find(row => row.title === ${JSON.stringify(fixture)}).click();
      const accept = document.querySelector('.path-dialog .modal-actions .primary');
      if (accept.disabled) throw new Error('Selecting the PNG did not enable confirmation');
      accept.click();
    })()`);
    await wait_for(pictures_loaded(targets), 'Title, sidebar and profile avatars did not decode to 128 by 128');
    const selected_data = await evaluate(`document.querySelector('#title-avatar img').src`) as string;
    const converted = nativeImage.createFromDataURL(selected_data).getSize();
    if (converted.width !== 128 || converted.height !== 128) throw new Error('Avatar IPC did not produce the required PNG dimensions.');
    await evaluate(`(async () => {
      if ((await window.ai_code.invoke({ type: 'ready' })).cwd !== '') throw new Error('Selecting an avatar must not open a project');
      if (localStorage.getItem(${JSON.stringify(storage_keys[0])}) !== ${JSON.stringify(selected_data)}) throw new Error('Avatar was not saved under its synthetic account');
    })()`);
    await evaluate(`document.querySelector('.account-dialog .modal-actions .primary').click()`);

    /// 真实重载本地文档，验证图片由持久存储恢复而非只驻留在当前 DOM。
    let loaded: (() => void) | undefined;
    const reloaded = new Promise<void>(resolve => { loaded = resolve; window.webContents.once('did-finish-load', loaded); });
    try { window.webContents.reload(); await diagnostic_deadline(reloaded, 3_000); }
    finally { if (loaded) window.webContents.removeListener('did-finish-load', loaded); }
    await wait_for(pictures_loaded(['title-avatar', 'sidebar-avatar'], selected_data), 'Avatar was not restored after reloading the local page');
    await evaluate(`document.getElementById('title-account').click()`);
    await wait_for(pictures_loaded(targets, selected_data), 'Reloaded account dialog did not restore the avatar');

    offline_state = { ...offline_state, account: second_name, account_email: second_email };
    emit({ type: 'state', state: offline_state });
    await wait_for(`document.getElementById('profile-name')?.textContent === ${JSON.stringify(second_name)} && (${default_pictures})`, 'A different account reused the first account avatar');
    offline_state = { ...offline_state, account: first_name, account_email: first_email };
    emit({ type: 'state', state: offline_state });
    await wait_for(`document.getElementById('profile-name')?.textContent === ${JSON.stringify(first_name)} && (${pictures_loaded(targets, selected_data)})`, 'Switching back did not restore the account avatar');
    await evaluate(`document.getElementById('clear-avatar').click()`);
    await wait_for(`(${default_pictures}) && document.getElementById('clear-avatar')?.disabled`, 'Restore default did not reset every avatar view');
    await evaluate(`(() => {
      if (localStorage.getItem(${JSON.stringify(storage_keys[0])}) !== null) throw new Error('Restore default did not remove the persisted avatar');
      document.querySelector('.account-dialog .modal-actions .primary').click();
      const controls = Array.from(document.querySelectorAll('.window-controls > button')).map(button => button.id).join(',');
      if (controls !== 'title-account,minimize,maximize,close') throw new Error('Title bar controls are not in the expected order');
    })()`);
    await evaluate(`document.getElementById('maximize').click()`);
    await wait_for(`document.getElementById('maximize')?.getAttribute('aria-label') === ${JSON.stringify(previous_maximized ? '最大化' : '还原')}`, 'Maximize/restore label did not follow the native window');
    if (window.isMaximized() === previous_maximized) throw new Error('Title bar maximize action did not change native window state.');
    await evaluate(`document.getElementById('maximize').click()`);
    await wait_for(`document.getElementById('maximize')?.getAttribute('aria-label') === ${JSON.stringify(previous_maximized ? '还原' : '最大化')}`, 'Restoring the native window did not restore its label');
    if (window.isMaximized() !== previous_maximized) throw new Error('Window state did not return after the second title bar action.');
    if (state().cwd !== '') throw new Error('Avatar workflow changed the selected project.');
  } finally {
    if (!window.isDestroyed()) {
      await evaluate(`(() => {
        document.querySelector('.modal-header button[aria-label="关闭弹窗"]')?.click();
        ${JSON.stringify(storage_keys)}.forEach(key => localStorage.removeItem(key));
      })()`).catch(() => undefined);
      if (window.isMaximized() !== previous_maximized) {
        if (previous_maximized) window.maximize(); else window.unmaximize();
      }
    }
    offline_state = previous_state;
    emit({ type: 'state', state: offline_state });
    if (fixture_created) await fs.unlink(fixture).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
  process.stdout.write('Avatar UI smoke passed: synthetic PNG selection, three decoded views, reload persistence, account isolation, default reset, and title bar controls.\n');
}

/** @brief 在本地自检页执行有三秒截止的 DOM 断言。 */
function smoke_script(window: BrowserWindow, source: string): Promise<unknown> {
  return diagnostic_deadline(window.webContents.executeJavaScript(source), 3_000);
}

/** @brief 等待本地测试 DOM 条件，最多轮询 2.8 秒。 */
function smoke_wait(window: BrowserWindow, condition: string, message: string): Promise<unknown> {
  return smoke_script(window, `(async () => {
    const deadline = performance.now() + 2800;
    while (!(${condition})) {
      if (performance.now() >= deadline) throw new Error(${JSON.stringify(message)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
}

/** @brief 仅捕获当前应用的本地自检页，并将 PNG 写入指定测试输出。 */
async function capture_smoke(window: BrowserWindow, output: string): Promise<void> {
  await smoke_script(window, 'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await diagnostic_deadline((async () => { await fs.writeFile(output, (await window.webContents.capturePage()).toPNG()); })(), 3_000);
}

/**
 * @brief 启动一个真实但无后台的 Electron 子窗口，验证草稿确认、commit 和独立退出。
 * @param window 父自检窗口，其状态与输入在整个交接期间必须保持原样。
 * @returns 收到仅含布尔值的子窗口报告并验证其退出后的 Promise。
 * @note 只关闭本测试创建的进程对象；不枚举或终止其他客户端进程。
 */
async function run_side_chat_smoke(window: BrowserWindow): Promise<void> {
  if (!smoke || backend) throw new Error('Side chat smoke requires offline preview.');
  const before = JSON.stringify(state());
  const draft = await smoke_script(window, `document.getElementById('prompt').value`);
  const fixture = '离线侧边聊天交接自检。此草稿只显示，不请求模型。';
  let child: ChildProcess | null = null;
  let output = ''; let errors = '';
  let exited: Promise<number | null> = Promise.resolve(null);
  let receive_report: (line: string) => void = () => undefined;
  const reported = new Promise<string>(resolve => { receive_report = resolve; });
  const manager = new side_chat_launcher({ executable_path: process.execPath, application_path: app.getAppPath(), packaged: app.isPackaged }, {
    spawn_child: (executable, arguments_list, options) => {
      if (arguments_list.some(argument => argument.includes(fixture))) throw new Error('Side chat draft leaked into process arguments.');
      const launched = spawn(executable, [...arguments_list, '--preview', '--side-chat-smoke', '--side-chat-smoke-screenshot', path.resolve('build/side_chat_smoke.png')],
        { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child = launched;
      launched.stdout?.setEncoding('utf8'); launched.stderr?.setEncoding('utf8');
      launched.stdout?.on('data', (chunk: string) => {
        if (output.length < 65_536) output += chunk.slice(0, 65_536 - output.length);
        const line = output.split(/\r?\n/u).find(item => item.startsWith('AI_CODE_SIDE_CHAT_SMOKE:') && item.endsWith('}'));
        if (line) receive_report(line);
      });
      launched.stderr?.on('data', (chunk: string) => { if (errors.length < 4096) errors += chunk.slice(0, 4096 - errors.length); });
      /// Windows 上辅助进程可能短暂继承输出管道；进程退出与管道 close 是两个独立事件。
      exited = new Promise(resolve => { launched.once('exit', resolve); launched.once('error', () => resolve(-1)); });
      return launched;
    },
  });
  try {
    await manager.open_side_chat({ text: fixture, roots: [], project_name: '离线交接自检', model: 'offline-model-fixture' });
    const code = await diagnostic_deadline(exited, 15_000).catch(() => {
      throw new Error(`Side chat smoke timed out waiting for its Electron process exit; commit_report_received=${output.includes('AI_CODE_SIDE_CHAT_SMOKE:')}.`);
    });
    if (code !== 0) throw new Error(`Offline side chat did not exit successfully. ${errors}`);
    const report_line = await diagnostic_deadline(reported, 3_000).catch(() => { throw new Error('Side chat exited without a completed commit report.'); });
    const report = JSON.parse(report_line.slice('AI_CODE_SIDE_CHAT_SMOKE:'.length)) as Record<string, unknown>;
    for (const key of ['committed', 'draft_retained', 'branded', 'preview', 'no_backend', 'no_messages', 'no_project', 'read_only', 'isolated_profile', 'model_received']) {
      if (report[key] !== true) throw new Error(`Offline side chat invariant failed: ${key}.`);
    }
    if (manager.active_count !== 0 || JSON.stringify(state()) !== before || await smoke_script(window, `document.getElementById('prompt').value`) !== draft) {
      throw new Error('Side chat changed its parent state or failed to release its window slot.');
    }
  } finally {
    const launched = child as ChildProcess | null;
    if (launched && launched.exitCode === null && !launched.killed) {
      launched.kill();
      await diagnostic_deadline(exited, 3_000).catch(() => undefined);
    }
    if (!window.isDestroyed()) window.focus();
  }
  process.stdout.write('Side chat UI smoke passed: real isolated child, draft acknowledgement, committed handoff, model transfer, no backend, unchanged parent, and child exit.\n');
}

/**
 * @brief 通过真实渲染页和受限 IPC 验证生成菜单、键盘映射、拒绝保稿及队列交互。
 * @param window 无后台的离线主窗口。
 * @returns 自检完成后恢复原状态及草稿，不启动模型或侧边聊天后台。
 */
async function run_response_smoke(window: BrowserWindow, attachment: string): Promise<void> {
  if (!smoke || backend) throw new Error('Response smoke requires offline preview.');
  const previous = offline_state;
  const previous_prompt = await smoke_script(window, `document.getElementById('prompt').value`) as string;
  let release: (() => void) | undefined;
  const fill = (text: string): Promise<unknown> => smoke_script(window, `(() => {
    const prompt = document.getElementById('prompt'); prompt.value = ${JSON.stringify(text)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const menu_click = (id: string): Promise<unknown> => smoke_script(window, `(() => {
    if (document.getElementById('response-menu').hidden) document.getElementById('response-options').click();
    const button = document.getElementById(${JSON.stringify(id)});
    if (button.disabled) throw new Error('A response action is unexpectedly disabled');
    button.click();
  })()`);
  const expect_action = async (count: number, type: string, text: string, cleared = true): Promise<void> => {
    await smoke_wait(window, `!document.getElementById('response-options').disabled${cleared ? " && document.getElementById('prompt').value === ''" : ''}`, 'A response action did not settle');
    const recorded = response_smoke_actions[count];
    if (response_smoke_actions.length !== count + 1 || recorded?.type !== type || recorded.text !== text) throw new Error('A response menu or shortcut dispatched the wrong action.');
  };
  try {
    response_smoke_enabled = true; response_smoke_actions.length = 0;
    offline_state = { ...previous, connected: true, authenticated: true, busy: true, stopping: false, session_loading: false,
      status: '离线交互自检 · 没有模型请求', model: 'offline-model-fixture', models: [{ id: 'offline-model-fixture', name: '离线测试模型' }],
      queued_messages: [{ id: 'offline-first', text: '之后检查项目目录的读取边界。' }] };
    emit({ type: 'state', state: offline_state });
    await smoke_wait(window, `!document.getElementById('response-controls').hidden && document.querySelectorAll('.queued-message').length === 1`, 'Busy controls or queued messages were not rendered');
    await fill('继续检查当前实现，并说明下一步。');
    await smoke_script(window, `(() => {
      document.getElementById('response-options').click();
      const menu = document.getElementById('response-menu');
      if (menu.hidden || menu.querySelectorAll('[role="menuitem"]').length !== 4) throw new Error('The busy menu must show all four actions');
      if (document.activeElement.id !== 'stop-and-send') throw new Error('Opening the menu did not focus its first action');
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      if (document.activeElement.id !== 'queue-message') throw new Error('Arrow navigation did not select the next response action');
    })()`);
    await capture_smoke(window, path.resolve('build/response_menu_smoke.png'));
    await smoke_script(window, `(() => {
      document.getElementById('response-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (!document.getElementById('response-menu').hidden || document.activeElement.id !== 'response-options') throw new Error('Escape did not close the response menu and restore focus');
    })()`);
    for (const [id, type] of [['stop-and-send', 'stop_and_send'], ['queue-message', 'queue_message'], ['steer-message', 'steer_message'], ['side-chat', 'side_chat']]) {
      const text = `离线菜单自检 ${type}`; const count = response_smoke_actions.length;
      await fill(text); await menu_click(id); await expect_action(count, type, text);
    }
    for (const [type, modifier] of [['steer_message', ''], ['queue_message', 'altKey'], ['stop_and_send', 'ctrlKey']]) {
      const text = `离线快捷键自检 ${type}`; const count = response_smoke_actions.length;
      await fill(text);
      await smoke_script(window, `(() => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true${modifier ? `, ${modifier}: true` : ''} });
        document.getElementById('prompt').dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error('Busy Enter shortcut was not handled');
      })()`);
      await expect_action(count, type, text);
    }
    const before_newline = response_smoke_actions.length;
    await fill('换行时保留草稿');
    await smoke_script(window, `(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      document.getElementById('prompt').dispatchEvent(event);
      if (event.defaultPrevented) throw new Error('Shift Enter must preserve native newline handling');
    })()`);
    if (response_smoke_actions.length !== before_newline) throw new Error('Shift Enter dispatched a follow-up action.');
    response_smoke_reject = true;
    const rejected = '被明确拒绝的离线草稿'; const rejected_count = response_smoke_actions.length;
    await fill(rejected); await menu_click('steer-message');
    await smoke_wait(window, `!document.getElementById('response-options').disabled && document.getElementById('toast').textContent.includes('明确拒绝')`, 'Rejected follow-up did not show its error');
    await expect_action(rejected_count, 'steer_message', rejected, false);
    if (await smoke_script(window, `document.getElementById('prompt').value`) !== rejected) throw new Error('Rejected follow-up lost its original draft.');
    const pending = '等待交接的离线草稿'; const newer = '交接期间输入的新草稿';
    response_smoke_gate = new Promise<void>(resolve => { release = resolve; });
    await fill(pending); await menu_click('queue-message');
    await smoke_wait(window, `document.getElementById('response-options').disabled`, 'Pending response did not block duplicate actions');
    await fill(newer); release?.(); response_smoke_gate = null;
    await smoke_wait(window, `!document.getElementById('response-options').disabled && Array.from(document.querySelectorAll('.queued-message>span')).some(node => node.title === ${JSON.stringify(pending)})`, 'Pending queued text was not rendered');
    if (await smoke_script(window, `document.getElementById('prompt').value`) !== newer) throw new Error('Accepted follow-up overwrote newer input.');
    const queue_size = offline_state.queued_messages?.length ?? 0;
    await smoke_script(window, `document.querySelector('.queued-message button').click()`);
    await smoke_wait(window, `document.querySelectorAll('.queued-message').length === ${queue_size - 1}`, 'Removing a queued message did not update the list');
    offline_state = { ...offline_state, busy: false }; emit({ type: 'state', state: offline_state });
    await smoke_wait(window, `document.getElementById('response-controls').hidden && !document.getElementById('resume-queue').hidden`, 'Idle queue did not expose its explicit resume control');
    await smoke_script(window, `document.getElementById('resume-queue').click()`);
    await smoke_wait(window, `document.getElementById('message-queue').hidden`, 'Resuming the offline queue did not dispatch its action');
    if (response_smoke_actions.at(-1)?.type !== 'resume_queue') throw new Error('Queue resume was not dispatched.');
    offline_state = { ...offline_state, thread_id: '' }; emit({ type: 'state', state: offline_state });
    await smoke_wait(window, `!document.getElementById('attach').disabled`, 'Idle project attachments were not available');
    await smoke_script(window, `document.getElementById('attach').click()`);
    await smoke_wait(window, `Array.from(document.querySelectorAll('.path-row')).some(row => row.title === ${JSON.stringify(attachment)})`, 'The synthetic project attachment was not listed');
    await smoke_script(window, `(() => {
      Array.from(document.querySelectorAll('.path-row')).find(row => row.title === ${JSON.stringify(attachment)}).click();
      document.querySelector('.path-dialog .modal-actions .primary').click();
    })()`);
    await smoke_wait(window, `document.querySelectorAll('#attachments .attachment').length === 1`, 'The synthetic attachment was not added');
    offline_state = { ...offline_state, busy: true }; emit({ type: 'state', state: offline_state });
    await smoke_wait(window, `!document.getElementById('response-controls').hidden`, 'First-thread follow-up state was not rendered');
    response_smoke_thread_start = true;
    response_smoke_gate = new Promise<void>(resolve => { release = resolve; });
    const first_thread = '首次会话创建期间停止并发送';
    await fill(first_thread);
    await smoke_script(window, `document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await smoke_wait(window, `document.getElementById('response-options').disabled && !document.getElementById('response-controls').hidden`, 'First-thread replacement did not reach its pending state');
    await smoke_script(window, `new Promise(resolve => setTimeout(resolve, 50))`);
    if (offline_state.thread_id !== 'offline-started-thread' || !offline_state.busy) throw new Error('First-thread replacement fixture did not publish idle and busy states.');
    if (await smoke_script(window, `document.getElementById('prompt').value === ${JSON.stringify(first_thread)} && document.querySelectorAll('#attachments .attachment').length === 1`) !== true) {
      throw new Error('First thread assignment discarded its pending draft or attachment.');
    }
    release?.(); response_smoke_gate = null;
    await smoke_wait(window, `document.getElementById('prompt').value === '' && document.querySelectorAll('#attachments .attachment').length === 0 && !document.getElementById('response-options').disabled`, 'First-thread replacement acknowledgement did not clear the accepted draft and attachment');
    offline_state = { ...offline_state, busy: false }; emit({ type: 'state', state: offline_state });
    await smoke_wait(window, `document.getElementById('response-controls').hidden`, 'Normal-send fixture did not become idle');
    response_smoke_reject = true;
    response_smoke_gate = new Promise<void>(resolve => { release = resolve; });
    await fill('普通发送等待明确拒绝');
    await smoke_script(window, `document.getElementById('send').click()`);
    await smoke_wait(window, `document.getElementById('send').disabled`, 'Normal send did not prevent duplicate submission');
    await fill('普通发送等待期间的新输入'); release?.(); response_smoke_gate = null;
    await smoke_wait(window, `!document.getElementById('send').disabled`, 'Rejected normal send did not settle');
    if (await smoke_script(window, `document.getElementById('prompt').value`) !== '普通发送等待期间的新输入') throw new Error('Rejected normal send overwrote newer input.');
    await fill('普通发送接收成功');
    await smoke_script(window, `document.getElementById('send').click()`);
    await smoke_wait(window, `document.getElementById('prompt').value === ''`, 'Accepted normal send did not clear its unchanged draft');
    if (response_smoke_actions.at(-1)?.type !== 'send') throw new Error('Normal send did not dispatch its real IPC action.');
  } finally {
    release?.(); response_smoke_gate = null; response_smoke_reject = false; response_smoke_thread_start = false; response_smoke_enabled = false;
    offline_state = previous; emit({ type: 'state', state: offline_state });
    await fill(previous_prompt).catch(() => undefined);
  }
  process.stdout.write('Response UI smoke passed: four menu actions, keyboard shortcuts, rejection preservation, newer draft preservation, queue removal and resume.\n');
}

/**
 * @brief 使用临时目录验证项目选择、独立根目录折叠、文件边界及空项目表现。
 * @param window 使用隔离 userData 的本地离线自检窗口。
 * @returns UI 与真实项目 IPC 检查完成后的 Promise，随后清理本测试定义与目录。
 * @throws Error 项目状态、目录边界或 DOM 断言失败。
 */
async function run_project_smoke(window: BrowserWindow): Promise<void> {
  if (!smoke || backend) throw new Error('Project smoke requires offline preview.');
  const previous_state = offline_state;
  const previous_selection = active_project_id;
  const previous_files = files;
  const previous_error = project_error;
  const store = project_storage();
  const temporary = await fs.mkdtemp(path.join(app.getPath('userData'), 'project-smoke-'));
  const roots = [path.join(temporary, 'first'), path.join(temporary, 'second')];
  const fixtures = [path.join(roots[0], 'one.txt'), path.join(roots[1], 'two.txt'), path.join(temporary, 'outside.txt')];
  const name = `目录自检 ${path.basename(temporary)}`;
  const empty_name = `${name} 空目录`;
  const evaluate = (script: string): Promise<unknown> => diagnostic_deadline(window.webContents.executeJavaScript(script), 3_000);
  const wait_for = (condition: string, message: string): Promise<unknown> => evaluate(`(async () => {
    const deadline = performance.now() + 2800;
    while (!(${condition})) {
      if (performance.now() >= deadline) throw new Error(${JSON.stringify(message)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
  try {
    for (const root of roots) await fs.mkdir(root);
    for (const [index, file] of fixtures.entries()) await fs.writeFile(file, `fixture-${index}`, { flag: 'wx' });
    const selected = await evaluate(`window.ai_code.invoke(${JSON.stringify({ type: 'save_project', name, directories: roots })})`) as app_state;
    if (!selected.active_project_id || !same_roots(workspace_roots(selected), roots)) throw new Error('Saving a project did not select both explicit roots.');
    await wait_for(`document.querySelectorAll('.directory-toggle').length === 2 && !document.getElementById('files-section').hidden`, 'Project roots did not render as independent directory sections');
    await evaluate(`(() => {
      const toggles = Array.from(document.querySelectorAll('.directory-toggle'));
      if (toggles.some(toggle => toggle.getAttribute('aria-expanded') !== 'false')) throw new Error('New project directories must start collapsed');
      toggles[0].click();
      if (toggles[1].getAttribute('aria-expanded') !== 'false') throw new Error('Expanding one project root changed another');
      const sessions = document.getElementById('toggle-sessions');
      sessions.click();
      if (toggles[0].getAttribute('aria-expanded') !== 'true') throw new Error('Session folding changed a directory root');
      sessions.click();
      toggles[1].click();
    })()`);
    await wait_for(`Array.from(document.querySelectorAll('.tree-row')).some(row => row.title === ${JSON.stringify(fixtures[0])}) && Array.from(document.querySelectorAll('.tree-row')).some(row => row.title === ${JSON.stringify(fixtures[1])})`, 'Files from both roots were not independently loaded');
    await capture_smoke(window, path.resolve('build/projects_multi_roots_smoke.png'));
    await run_response_smoke(window, fixtures[0]);
    await evaluate(`(async () => {
      for (const [index, path] of ${JSON.stringify(fixtures.slice(0, 2))}.entries()) {
        const preview = await window.ai_code.invoke({ type: 'read_file', path });
        if (preview.content !== 'fixture-' + index) throw new Error('A selected project root was not readable');
      }
      let denied = false;
      try { await window.ai_code.invoke({ type: 'read_file', path: ${JSON.stringify(fixtures[2])} }); } catch { denied = true; }
      if (!denied) throw new Error('Project roots were incorrectly widened to their common parent');
      document.getElementById('open-project').click();
      const search = document.getElementById('project-search');
      search.value = ${JSON.stringify(name)};
      search.dispatchEvent(new Event('input', { bubbles: true }));
      if (document.querySelectorAll('.project-option').length !== 1) throw new Error('Project name search did not isolate the saved project');
      document.getElementById('open-project').click();
    })()`);
    const reopened = new project_store(path.join(app.getPath('userData'), 'projects.json'));
    await reopened.load();
    if (!same_roots(reopened.find(selected.active_project_id)?.directories ?? [], roots)) throw new Error('Saved project roots did not survive configuration reload.');
    const empty = await evaluate(`window.ai_code.invoke(${JSON.stringify({ type: 'save_project', name: empty_name, directories: [] })})`) as app_state;
    if (!empty.active_project_id || empty.cwd || workspace_roots(empty).length) throw new Error('An empty project inherited a previous workspace.');
    await wait_for(`document.getElementById('files-section').hidden && document.querySelectorAll('.directory-toggle').length === 0`, 'An empty project did not hide the entire directory area');
    await evaluate(`window.ai_code.invoke({ type: 'select_project', id: '' })`);
    if (state().active_project_id || state().cwd || workspace_roots(state()).length) throw new Error('Leaving a project did not clear its directory boundaries.');
  } finally {
    await evaluate(`document.querySelector('.modal-header button[aria-label="关闭弹窗"]')?.click()`).catch(() => undefined);
    for (const entry of store.catalog.filter(project => project.name === name || project.name === empty_name)) {
      const storage_keys = entry.directories.map(root => `directory_expanded:${entry.id}:${root}`);
      await evaluate(`${JSON.stringify(storage_keys)}.forEach(key => localStorage.removeItem(key))`).catch(() => undefined);
      await store.delete_project(entry.id);
    }
    active_project_id = previous_selection; files = previous_files; offline_state = previous_state; project_error = previous_error;
    emit({ type: 'state', state: offline_state });
    for (const file of fixtures) await fs.unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    for (const root of roots) await fs.rmdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await fs.rmdir(temporary);
  }
  process.stdout.write('Project UI smoke passed: saved multi-root project, independent folding, bounded reads, search, empty project, and explicit leave.\n');
}

/**
 * @brief 离线检查桥接隔离、界面行为、Markdown 和认证壳的安全边界。
 * @param window 已加载本地界面的预览窗口。
 * @returns 所有 UI 自检完成后的 Promise，不访问官方页面或凭据。
 * @throws Error DOM、IPC、项目读取或认证隔离断言失败。
 */
async function run_ui_smoke(window: BrowserWindow): Promise<void> {
  if (backend) throw new Error('UI smoke must not start the backend.');
  if (!argument('--project') && state().cwd !== '') throw new Error('Startup must not select a project implicitly.');
  await window.webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const initial = await window.ai_code.invoke({type:'ready'});
    check(initial.preview, 'Preview state is required');
    check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'Node must be unavailable in renderer');
    check(Object.keys(window.ai_code).sort().join(',') === 'invoke,on_event', 'Preload exposes only the intended bridge');
    check(document.querySelector('meta[http-equiv="Content-Security-Policy"]'), 'CSP is present');
    const format = await import('./format.js');
    const parsed = document.createElement('div');
    parsed.innerHTML = format.markdown('<img src=x onerror=alert(1)>');
    check(!parsed.querySelector('img,script,iframe'), 'Markdown does not create injected elements');
    const fence = String.fromCharCode(96).repeat(3);
    parsed.innerHTML = format.markdown(fence + 'html\\n<script>alert(1)</script>\\n' + fence);
    check(!parsed.querySelector('script') && parsed.querySelector('pre code')?.textContent.includes('<script>'), 'Fenced code stays escaped');
    const sessions = document.getElementById('toggle-sessions');
    const before_sessions = sessions.getAttribute('aria-expanded');
    sessions.click();
    check(sessions.getAttribute('aria-expanded') !== before_sessions, 'Session section folds');
    sessions.click();
    check(sessions.getAttribute('aria-expanded') === before_sessions, 'Session section stays independent');
    if (!initial.cwd) check(document.getElementById('files-section').hidden, 'No directories means the directory area is hidden');
    const user = document.querySelector('.message.user');
    check(user && getComputedStyle(user).alignItems === 'flex-end', 'User messages align to the right');
    document.getElementById('about').click();
    check(!document.getElementById('modal-layer').hidden && document.querySelector('.modal[role="dialog"]'), 'About uses a custom modal');
    document.querySelector('.modal-actions button').click();
    check(document.getElementById('modal-layer').hidden, 'About modal closes');
    document.getElementById('open-project').click();
    check(!document.getElementById('project-menu').hidden && document.getElementById('project-search'), 'Projects use a searchable menu');
    document.getElementById('new-project').click();
    check(document.querySelector('.project-dialog') && document.getElementById('project-name'), 'New project uses a custom editor');
    document.getElementById('add-project-directory').click();
    check(document.querySelector('.path-dialog') && document.querySelector('.path-input'), 'Folder picker uses a custom modal');
    const listing = await window.ai_code.invoke({type:'list_directory',path:initial.cwd,project_only:Boolean(initial.cwd)});
    check(Array.isArray(listing.entries) && (initial.cwd ? listing.path : listing.path === ''), 'Folder picker receives filesystem data or drive roots');
    if (!initial.cwd) {
      check(document.querySelector('.path-input').value === '', 'Folder picker does not restore a project');
      let rejected_project = false;
      try { await window.ai_code.invoke({type:'list_directory',path:'',project_only:true}); } catch { rejected_project = true; }
      check(rejected_project, 'Project reads require an explicitly selected project');
    }
    document.querySelector('.modal-header button[aria-label="关闭弹窗"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('.project-dialog .modal-header button[aria-label="关闭弹窗"]')?.click();
    let rejected = false;
    try { await window.ai_code.invoke({type:'unknown-action'}); } catch { rejected = true; }
    check(rejected, 'Unknown IPC actions are rejected');
  })()`);
  offline_state = { ...offline_state, busy: true };
  emit({ type: 'state', state: offline_state });
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('close').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    const modal = document.querySelector('.modal');
    if (!modal || !modal.getAttribute('aria-label').includes('关闭')) throw new Error('Busy close requires a custom confirmation');
    document.querySelector('.modal-actions button').click();
  })()`);
  offline_state = { ...offline_state, busy: false };
  emit({ type: 'state', state: offline_state });
  /// 自检只创建本地壳及空白认证视图，不加载官方登录页面或访问凭据。
  await open_login('https://auth.openai.com/', false);
  const login_window = auth_window as BrowserWindow | null;
  const login_view = auth_view as WebContentsView | null;
  if (!login_window || !login_view) throw new Error('Authentication shell was not created.');
  /// 使用 Electron 公开 API 检查显式创建的空白页面，不在官方远端文档执行脚本。
  await login_view.webContents.loadURL('about:blank');
  const isolated = await login_view.webContents.executeJavaScript(`({ node: typeof require !== 'undefined' || typeof process !== 'undefined', bridge: typeof window.ai_code !== 'undefined' })`) as { node: boolean; bridge: boolean };
  if (isolated.node || isolated.bridge || login_view.webContents.session === window.webContents.session) {
    throw new Error('Authentication browser isolation is not enabled.');
  }
  auth_error = '已阻止不安全的测试跳转。';
  emit_auth();
  await login_window.webContents.executeJavaScript(`(async () => {
    await window.ai_code.invoke({type:'ready'});
    if (!document.body.classList.contains('auth-mode')) throw new Error('Authentication shell mode is missing');
    if (document.getElementById('auth-origin').textContent !== 'https://auth.openai.com') throw new Error('Only the login origin is displayed');
    if (!document.getElementById('auth-error').textContent.includes('已阻止')) throw new Error('Blocked navigation has a visible explanation');
    let rejected = false;
    try { await window.ai_code.invoke({type:'list_directory',path:'C:\\\\'}); } catch { rejected = true; }
    if (!rejected) throw new Error('Authentication shell must not access project IPC');
    let avatar_rejected = false;
    try { await window.ai_code.invoke({type:'read_avatar',path:''}); } catch (error) { avatar_rejected = String(error).includes('登录窗口不允许'); }
    if (!avatar_rejected) throw new Error('Authentication shell must reject avatar IPC before accessing a file');
  })()`);
  close_login();
  window.focus();
  await run_avatar_smoke(window);
  await run_project_smoke(window);
  await run_side_chat_smoke(window);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  process.stdout.write('Electron UI smoke passed: isolated preload, sidebar folding, messages, custom dialogs, filesystem IPC, and offline authentication shell.\n');
}

/**
 * @brief 使用临时账号目录验证官方 HTTPS 登录页面能否在内置窗口加载。
 * @returns 页面完成加载并取消登录、释放后端后的 Promise。
 * @throws Error 后端启动失败、页面超时或截图写入失败。
 * @note 不输入凭据、不请求模型，也不将页面加载视为完整 OAuth 成功。
 */
async function run_auth_smoke(): Promise<void> {
  const service = backend;
  if (!service) throw new Error('Authentication smoke requires an isolated backend.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let progress: ReturnType<typeof setInterval> | undefined;
  let origin = '';
  const started = Date.now();
  try {
    const loaded = new Promise<string>((resolve, reject) => {
      auth_smoke_loaded = resolve;
      timeout = setTimeout(() => reject(new Error('Official login page did not finish loading within 90 seconds.')), 90_000);
    });
    progress = setInterval(() => {
      process.stdout.write(`Authentication smoke waiting: ${Math.round((Date.now() - started) / 1000)} seconds; origin=${auth_last_origin || '(not opened)'}; status=${auth_load_status}.\n`);
    }, 20_000);
    [, origin] = await Promise.all([(async () => { await service.connect(); await service.login(); })(), loaded]);
    if (timeout) clearTimeout(timeout);
    if (progress) clearInterval(progress);
    await new Promise(resolve => setTimeout(resolve, 350));
    const diagnostic = await save_auth_diagnostics('passed', started);
    process.stdout.write(`Authentication smoke diagnostics saved: ${diagnostic}\n`);
  } catch {
    if (timeout) clearTimeout(timeout);
    if (progress) clearInterval(progress);
    let diagnostic = '';
    try { diagnostic = await save_auth_diagnostics('failed', started); }
    catch { process.stderr.write('Authentication smoke diagnostics could not be saved.\n'); }
    throw new Error(`Official login page loading was not verified; origin=${auth_last_origin || '(not opened)'}; status=${auth_load_status}; error_code=${auth_load_error_code ?? 'none'}.${diagnostic ? ` Diagnostics: ${diagnostic}` : ''}`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (progress) clearInterval(progress);
    auth_smoke_loaded = null;
    await service.cancel_login().catch(() => undefined);
    close_login();
    await service.dispose().catch(() => undefined);
    backend = null;
  }
  process.stdout.write(`Official login page loaded inside the client: ${origin}; page title present. No credentials entered, model request made, or full OAuth completion verified.\n`);
  quitting = true;
  app.quit();
}

/**
 * @brief 草稿得到本地界面确认并由父窗口提交后，才启动独立只读聊天。
 * @param window 当前侧边聊天的本地窗口。
 * @param handoff 已经过受限 IPC 验证的初始草稿及两阶段交接对象。
 * @returns 完成交接及首次提交，或保留草稿并显示受控错误后的 Promise。
 * @note 后台不确定失败沿用普通发送的语义，避免重新提交已被服务端接受的文本。
 */
async function initialize_side_chat(window: BrowserWindow, handoff: side_chat_handoff): Promise<void> {
  const service = backend;
  const available = (): boolean => !window.isDestroyed() && !quitting && !disposal;
  let sending = false;
  try {
    if (!side_draft_received) {
      await diagnostic_deadline(new Promise<void>(resolve => {
        side_draft_delivered = resolve;
        emit({ type: 'draft', text: side_pending_draft, acknowledge: true });
      }), 3_000);
    }
    side_draft_delivered = null;
    if (!available()) { handoff.reject_bootstrap(); return; }
    if (!await handoff.acknowledge_ready()) throw new Error('侧边聊天未收到发送许可，消息保留为草稿。');
    if (preview) {
      if (backend) throw new Error('Preview side chat unexpectedly created a backend.');
      if (side_chat_smoke) {
        const retained = await smoke_script(window, `document.getElementById('prompt').value === ${JSON.stringify(handoff.bootstrap.text)}`);
        const branded = await smoke_script(window, `document.querySelector('.brand>span:last-child').textContent.includes('侧边聊天')`);
        const output = argument('--side-chat-smoke-screenshot');
        if (output) await capture_smoke(window, path.resolve(output));
        const report = { committed: true, draft_retained: retained === true, branded: branded === true,
          preview: state().preview, no_backend: backend === null, no_messages: state().messages.length === 0,
          no_project: state().cwd === '' && workspace_roots(state()).length === 0, read_only: state().mode === 'read-only',
          isolated_profile: app.getPath('userData') !== standard_user_data,
          model_received: handoff.bootstrap.model === 'offline-model-fixture' };
        /// 测试报告由父进程独立验证；GUI 子进程不依赖 Windows stdout 回调才能退出。
        process.stdout.write(`AI_CODE_SIDE_CHAT_SMOKE:${JSON.stringify(report)}\n`);
        await new Promise<void>(resolve => setImmediate(resolve));
        window.close();
      }
      return;
    }
    if (!service) throw new Error('侧边聊天后台尚未准备完成。');
    await service.connect();
    if (!available()) return;
    if (!service.state.connected || !service.state.authenticated) throw new Error('侧边聊天尚未连接到 ChatGPT，请登录后发送保留的草稿。');
    await project_transaction(async () => {
      const candidate = new file_system_service();
      await candidate.set_roots(handoff.bootstrap.roots);
      const name = handoff.bootstrap.project_name?.trim();
      const entry = name || candidate.roots.length ? await project_storage().save_project(undefined,
        (name || path.basename(candidate.root) || '侧边聊天项目').slice(0, 80), candidate.roots) : undefined;
      await activate_project(entry?.id ?? '', candidate);
    });
    service.set_mode('read-only');
    if (handoff.bootstrap.model) {
      if (!service.state.models.some(model => model.id === handoff.bootstrap.model)) throw new Error('侧边聊天找不到原对话选中的模型，请选择可用模型后发送保留的草稿。');
      service.set_model(handoff.bootstrap.model);
    }
    if (!available()) return;
    side_initializing = false;
    sending = true;
    side_pending_draft = '';
    emit({ type: 'draft_sent', text: handoff.bootstrap.text });
    await service.send(handoff.bootstrap.text);
  } catch (error) {
    handoff.reject_bootstrap();
    if (side_chat_smoke) throw error;
    if (sending) {
      side_pending_draft = handoff.bootstrap.text;
      emit({ type: 'draft', text: side_pending_draft });
    }
    project_error = error instanceof Error ? error.message : '侧边聊天未能发送，消息保留为草稿。';
    emit({ type: 'state', state: service?.state ?? offline_state });
  } finally {
    side_draft_delivered = null;
    side_initializing = false;
  }
}

/**
 * @brief 初始化浅色窗口、受限会话、项目根及可选后端或自检流程。
 * @returns 启动或所选自检流程完成后的 Promise。
 * @throws Error 项目、构建产物、窗口或自检流程无法正常初始化。
 */
async function initialize(): Promise<void> {
  const side_handoff = side_handoff_promise ? await side_handoff_promise : null;
  if (side_chat && !side_handoff) throw new Error('侧边聊天没有收到有效的初始消息。');
  if (side_handoff) side_pending_draft = side_handoff.bootstrap.text;
  nativeTheme.themeSource = 'light';
  Menu.setApplicationMenu(null);
  const local = session.fromPartition('persist:ai-code-ui');
  local.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  local.setPermissionCheckHandler(() => false);
  local.on('will-download', event => event.preventDefault());
  local.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (url.protocol === 'file:') {
        const relative = path.relative(path.dirname(renderer_file), fileURLToPath(url));
        allowed = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      } else if (url.protocol === 'data:' || url.protocol === 'blob:') allowed = true;
    } catch { /* Local UI cannot request arbitrary network or file resources. */ }
    callback({ cancel: !allowed });
  });
  projects = new project_store(path.join(app.getPath('userData'), 'projects.json'));
  try { await projects.load(); }
  catch (error) { project_error = error instanceof Error ? error.message : '项目配置无法读取。'; }
  const requested_root = argument('--project');
  offline_state = { ...offline_state, cwd: '', workspace_roots: [] };
  if (!preview) {
    backend = new codex_backend({
      cwd: '',
      home: auth_smoke ? path.join(app.getPath('userData'), 'codex')
        : subscription_home,
      emit, open_login, close_login,
    });
  }
  if (requested_root) await project_transaction(() => choose_directory(path.resolve(requested_root)));
  ipcMain.handle('ai-code:action', invoke);
  const window = new BrowserWindow({
    width: 1460, height: 940, minWidth: 1000, minHeight: 680, frame: false, show: false,
    title: side_chat ? '侧边聊天 · AI Code' : 'AI Code · ChatGPT 编程工作台', backgroundColor: '#f8f8f8',
    webPreferences: { preload: preload_file, partition: 'persist:ai-code-ui', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  main_window = window;
  configure_local_window(window);
  window.on('close', event => {
    if (state().busy && !closing_confirmed && !quitting) { event.preventDefault(); emit({ type: 'close_requested' }); }
  });
  window.on('closed', () => { main_window = null; close_login(); });
  await window.loadFile(renderer_file, side_chat ? { query: { side_chat: '1' } } : {});
  window.show();
  if (side_handoff) { await initialize_side_chat(window, side_handoff); return; }
  if (auth_smoke) { await run_auth_smoke(); return; }
  if (backend) void backend.connect().catch(() => undefined);
  if (screenshot || smoke) {
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    await new Promise(resolve => setTimeout(resolve, 350));
    if (smoke) await run_ui_smoke(window);
    const image = await window.webContents.capturePage();
    const output = path.resolve(screenshot || 'build/electron-smoke.png');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, image.toPNG());
    quitting = true;
    app.quit();
  }
}

if (preview || auth_smoke || side_chat) app.setPath('userData', path.join(app.getPath('temp'), `ai-code-${side_chat ? 'side-chat' : 'preview'}-${process.pid}`));
const single_instance = preview || auth_smoke || side_chat || app.requestSingleInstanceLock();
if (!single_instance) app.quit();
app.on('second-instance', () => {
  if (main_window && !main_window.isDestroyed()) {
    if (main_window.isMinimized()) main_window.restore();
    main_window.show(); main_window.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || (!backend && !projects)) return;
  event.preventDefault();
  closing_confirmed = true;
  close_login();
  if (project_mapping_timer) { clearTimeout(project_mapping_timer); project_mapping_timer = undefined; }
  if (!disposal) disposal = (async () => {
    await projects?.flush().catch(() => undefined);
    await backend?.dispose().catch(() => undefined);
    quitting = true; app.quit();
  })();
});
if (single_instance) void app.whenReady().then(initialize).catch((error: unknown) => {
  /// 启动失败不弹出系统对话框，也不输出认证 URL。
  process.stderr.write(smoke || auth_smoke || side_chat_smoke ? `Electron smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    : 'AI Code 启动失败，请检查构建输出和项目路径。\n');
  quitting = true;
  app.exit(1);
});
