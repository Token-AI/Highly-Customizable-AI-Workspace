/** @file app.ts
 * @brief 原生 DOM 工作台、聊天呈现与统一弹窗的交互控制。
 * @details 页面没有 Node 能力，所有系统操作均通过受限 preload 请求主进程。
 */
import type { app_action, app_event, app_state, approval, directory_entry, directory_listing, export_result, file_preview, project_info } from '../shared/types.js';
import { basename, join_path, markdown } from './format.js';
import { icon, mount_icons } from './icons.js';
import { avatar_owner, clear_session_avatar, read_avatar_preference, render_avatar, write_avatar_preference } from './avatar.js';

const by_id = <t extends HTMLElement = HTMLElement>(id: string): t => document.getElementById(id) as t;
const button = (id: string) => by_id<HTMLButtonElement>(id);
const prompt = by_id<HTMLTextAreaElement>('prompt');
const auth_mode = new URLSearchParams(location.search).has('auth');
const side_chat_mode = new URLSearchParams(location.search).has('side_chat');
let state: app_state | undefined;
let rendering = false; let last_messages = ''; let last_sessions = ''; let last_models = ''; let tree_project: string | undefined;
let toast_timer: ReturnType<typeof setTimeout>; let modal_cleanup: (() => void) | undefined;
let attachments: file_preview[] = []; const approvals: approval[] = []; let handling_approval = false;
let active_approval_cancel: (() => void) | undefined; let context_epoch = 0; let preview_request = 0;
let avatar_identity = ''; let avatar_value = ''; let avatar_sequence = 0;
let last_projects = '';
let submission_pending = false; let last_queue = '';
mount_icons();
function toast(text: string): void { by_id('toast').textContent = text; by_id('toast').hidden = false; clearTimeout(toast_timer); toast_timer = setTimeout(() => { by_id('toast').hidden = true; }, 4300); }
function error_text(error: unknown): string { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error); }
/** @brief 请求主进程并保留失败状态，供调用者恢复草稿或显示错误。
 * @param action 待执行的受限业务操作。
 * @returns 主进程返回的类型化结果。
 */
async function invoke<t = unknown>(action: app_action): Promise<t> { return window.ai_code.invoke<t>(action); }
async function act(action: app_action): Promise<void> { try { await invoke(action); } catch (error) { toast(error_text(error)); } }
function on(id: string, action: () => void | Promise<void>): void { by_id(id).addEventListener('click', () => { void Promise.resolve(action()).catch(error => toast(error_text(error))); }); }
function set_disabled(id: string, disabled: boolean): void { button(id).disabled = disabled; }
/** @brief 创建统一弹窗并维护焦点约束、Esc 取消及关闭后的焦点恢复。
 * @param title 用于标题栏和无障碍标签的弹窗标题。
 * @param class_name 文件选择等专用布局的附加样式。
 * @returns 内容容器、操作容器和幂等关闭接口。
 */
function modal(title: string, class_name = ''): { element: HTMLDivElement; body: HTMLDivElement; actions: HTMLDivElement; close: () => void; cancel: (callback: () => void) => void } {
  modal_cleanup?.();
  const layer = by_id('modal-layer'); layer.replaceChildren(); layer.hidden = false;
  const previous = document.activeElement as HTMLElement | null;
  const element = document.createElement('div'); element.className = `modal ${class_name}`; element.role = 'dialog'; element.setAttribute('aria-modal', 'true'); element.setAttribute('aria-label', title); element.tabIndex = -1;
  const header = document.createElement('div'); header.className = 'modal-header'; const label = document.createElement('span'); label.textContent = title; header.append(label);
  const close_button = document.createElement('button'); close_button.className = 'icon-button'; close_button.setAttribute('aria-label', '关闭弹窗'); close_button.innerHTML = icon('close'); header.append(close_button);
  const body = document.createElement('div'); body.className = 'modal-body'; const actions = document.createElement('div'); actions.className = 'modal-actions';
  element.append(header, body, actions); layer.append(element);
  let cancel = () => close(); let closed = false;
  function keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === 'Tab') {
      const focusable = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, [tabindex="0"]')].filter(el => !el.hidden && el.getClientRects().length);
      if (!focusable.length) { event.preventDefault(); element.focus(); return; }
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }
  function close(): void { if (closed) return; closed = true; layer.hidden = true; layer.replaceChildren(); document.removeEventListener('keydown', keyboard, true); modal_cleanup = undefined; previous?.focus(); setTimeout(() => { void process_approvals(); }, 0); }
  close_button.onclick = () => cancel(); document.addEventListener('keydown', keyboard, true); modal_cleanup = () => cancel(); setTimeout(() => element.focus(), 0);
  return { element, body, actions, close, cancel: callback => { cancel = callback; } };
}
function dialog_button(label: string, primary = false): HTMLButtonElement { const node = document.createElement('button'); node.className = `button${primary ? ' primary' : ''}`; node.textContent = label; return node; }
/** @brief 以默认取消的方式取得用户对一项具体操作的确认。
 * @param title 弹窗标题。
 * @param detail 作为纯文本展示的完整操作说明。
 * @param primary 确认按钮文字。
 * @param cancel_label 取消按钮文字。
 * @param on_open 可接收幂等取消函数，用于使过期审批立即失效。
 * @returns 用户明确确认时返回 true，关闭或取消时返回 false。
 */
function confirm_dialog(title: string, detail: string, primary = '确定', cancel_label = '取消', on_open?: (cancel: () => void) => void): Promise<boolean> {
  return new Promise(resolve => {
    const view = modal(title); view.body.textContent = detail; const no = dialog_button(cancel_label); const yes = dialog_button(primary, true);
    let finished = false;
    const finish = (value: boolean) => { if (finished) return; finished = true; view.close(); resolve(value); }; no.onclick = () => finish(false); yes.onclick = () => finish(true); view.cancel(() => finish(false)); view.actions.append(no, yes); on_open?.(() => finish(false)); setTimeout(() => no.focus(), 0);
  });
}
/** @brief 串行呈现审批请求，避免覆盖当前弹窗或自动批准操作。 */
async function process_approvals(): Promise<void> {
  if (handling_approval || !by_id('modal-layer').hidden || !approvals.length) return;
  handling_approval = true; const approval = approvals.shift()!;
  try { const accepted = await confirm_dialog(approval.title, approval.detail, '允许本次操作', '拒绝', cancel => { active_approval_cancel = cancel; }); await act({ type: 'approve', id: approval.id, accept: accepted }); }
  finally { active_approval_cancel = undefined; handling_approval = false; void process_approvals(); }
}
/** @brief 在生成期间取得停止确认，再请求关闭对应窗口。 */
async function close_window(): Promise<void> {
  if (auth_mode) { await act({ type: 'window', command: 'close' }); return; }
  if (state?.busy && !await confirm_dialog('关闭 AI Code', '回复正在生成。关闭窗口将停止当前操作。', '停止并关闭')) return;
  await act({ type: 'window', command: 'close' });
}
on('minimize', () => act({ type: 'window', command: 'minimize' })); on('maximize', () => act({ type: 'window', command: 'maximize' })); on('close', close_window);
window.ai_code.on_event((event: app_event) => {
  if (event.type === 'window') { button('maximize').innerHTML = icon(event.maximized ? 'restore' : 'square'); button('maximize').ariaLabel = event.maximized ? '还原' : '最大化'; button('maximize').title = button('maximize').ariaLabel!; }
  else if (event.type === 'close_requested') void close_window();
  else if (event.type === 'draft' && !auth_mode) {
    if (!prompt.value.trim()) prompt.value = event.text;
    else if (prompt.value !== event.text && !prompt.value.startsWith(`${event.text}\n\n`)) prompt.value = `${event.text}\n\n${prompt.value}`;
    update_send();
    if (event.acknowledge) void invoke({ type: 'draft_ready', text: event.text }).catch(error => toast(error_text(error)));
  }
  else if (event.type === 'draft_sent' && !auth_mode) { if (prompt.value === event.text) { prompt.value = ''; prompt.style.height = ''; update_send(); } }
  else if (event.type === 'auth') { by_id('auth-origin').textContent = event.origin || '正在打开官方登录页面…'; by_id('auth-error').textContent = event.error || '在官方页面完成登录，成功后此窗口会自动关闭。'; }
  else if (event.type === 'approval') { approvals.push(event.approval); void process_approvals(); }
  else if (event.type === 'state' && !auth_mode) {
    // The first thread may become idle while a stop-and-send request is waiting for creation.
    const started_thread = state?.busy && !state.thread_id && Boolean(event.state.thread_id);
    const changed = state && (state.cwd !== event.state.cwd || (!started_thread && state.thread_id !== event.state.thread_id) || state.active_project_id !== event.state.active_project_id || JSON.stringify(state.workspace_roots) !== JSON.stringify(event.state.workspace_roots));
    if (state && avatar_owner(state) !== avatar_owner(event.state)) { clear_session_avatar(); ++avatar_sequence; }
    state = event.state;
    if (changed) { ++context_epoch; close_preview(); attachments = []; render_attachments(); }
    if (!state.connected || !state.busy) { approvals.length = 0; active_approval_cancel?.(); }
    schedule_render();
  }
});
if (auth_mode) {
  document.body.classList.add('auth-mode'); by_id('auth-brand').hidden = false; by_id('auth-toolbar').hidden = false; by_id('auth-error').hidden = false;
  document.querySelector('.brand>span:last-child')!.textContent = '连接 ChatGPT';
  void act({ type: 'ready' });
} else {
  initialize(); void invoke<app_state>({ type: 'ready' }).then(initial => { if (initial) { state = initial; schedule_render(); } }).catch(error => toast(error_text(error)));
}
/** @brief 将同一帧收到的状态更新合并为一次界面刷新。 */
function schedule_render(): void { if (rendering) return; rendering = true; requestAnimationFrame(() => { rendering = false; render(); }); }
/** @brief 根据完整状态同步按钮权限，并只重建发生变化的界面部分。 */
function render(): void {
  if (!state) return;
  const s = state; const working = s.busy || s.session_loading;
  const project = current_project();
  by_id('title-project').textContent = project?.name || (s.cwd ? basename(s.cwd) : '未打开项目'); by_id('title-project').title = project_roots().join('\n');
  by_id('project-label').textContent = project?.name || (s.cwd ? basename(s.cwd) : '不在项目中工作'); by_id('open-project').title = '选择项目';
  by_id('account-name').textContent = s.account || 'ChatGPT 账号'; by_id('account-name').title = s.account;
  render_profile();
  by_id('quota').textContent = s.quota || '使用订阅中的 Codex 额度'; by_id('status').textContent = s.status;
  by_id('login-label').textContent = s.login_pending ? '取消登录' : s.authenticated ? '退出当前账号' : '登录 ChatGPT';
  by_id('connection').classList.toggle('online', s.connected); by_id('connection').lastChild!.textContent = s.preview ? '界面预览' : s.connected ? '已连接' : s.connecting ? '连接中' : '未连接';
  by_id('error-banner').hidden = !s.error; by_id('error-banner').textContent = s.error;
  by_id('chat-title').textContent = s.sessions.find(session => session.id === s.thread_id)?.title || (s.messages.length ? '会话' : '新会话');
  by_id('chat-area').classList.toggle('empty', s.messages.length === 0);
  by_id('mode-label').textContent = s.mode === 'workspace-write' ? '项目智能体' : '只读聊天';
  by_id('model-label').textContent = s.models.find(m => m.id === s.model)?.name || s.model || '选择模型';
  for (const id of ['new-chat', 'open-project', 'mode-picker', 'model-picker', 'new-project', 'manage-project', 'leave-project']) set_disabled(id, working);
  set_disabled('manage-project', working || !project);
  set_disabled('login', working || (!s.connected && !s.preview)); set_disabled('reconnect', working || s.connecting);
  set_disabled('refresh', !s.connected || working); set_disabled('export', !s.messages.length || working);
  set_disabled('copy-reply', !s.messages.some(m => m.role === 'assistant'));
  set_disabled('show-diff', !s.diff);
  set_disabled('attach', working || !s.cwd || attachments.length >= 3);
  button('send').innerHTML = icon(s.busy ? 'stop' : 'arrow-up'); button('send').ariaLabel = s.busy ? '停止生成' : '发送消息'; button('send').title = s.busy ? '停止生成' : '发送 · Ctrl+Enter';
  button('send').classList.toggle('generating', s.busy);
  by_id('generation-hint').textContent = s.stopping ? '正在停止…' : s.session_loading ? '加载会话…' : s.busy ? '正在处理…' : '';
  by_id('response-controls').hidden = !s.busy;
  if (!s.busy) { by_id('response-menu').hidden = true; button('response-options').setAttribute('aria-expanded', 'false'); }
  by_id('composer-shortcuts').textContent = s.busy ? 'Enter 引导 · Alt+Enter 排队 · Shift+Enter 换行' : 'Ctrl+Enter 发送 · Enter 换行';
  render_queue();
  update_send();
  const message_key = JSON.stringify(s.messages);
  if (message_key !== last_messages) { last_messages = message_key; render_messages(); }
  const session_key = JSON.stringify([s.sessions, s.thread_id, working]);
  if (session_key !== last_sessions) { last_sessions = session_key; render_sessions(); }
  const model_key = JSON.stringify([s.models, s.model, s.mode, s.cwd]);
  if (model_key !== last_models) { last_models = model_key; render_pickers(); }
  const tree_key = JSON.stringify([s.active_project_id, project_roots()]);
  if (tree_project !== tree_key) { tree_project = tree_key; void refresh_tree(); }
  render_project_menu();
}
function update_send(): void {
  const s = state; const has_draft = Boolean(prompt.value.trim() || attachments.length);
  set_disabled('send', !s || s.stopping || s.session_loading || (!s.busy && (submission_pending || !s.authenticated || !s.connected || !s.models.some(model => model.id === s.model) || !has_draft)));
  const blocked = !s?.busy || !s.connected || !s.authenticated || !has_draft || s.stopping || submission_pending;
  for (const id of ['stop-and-send', 'queue-message', 'steer-message', 'side-chat']) set_disabled(id, blocked);
  set_disabled('response-options', !s?.busy || submission_pending);
}
/** @brief 显示待发送消息，并提供逐条取消入口。 */
function render_queue(): void {
  const queue = state?.queued_messages || []; const key = JSON.stringify([queue, state?.busy, state?.connected, state?.authenticated]);
  if (key === last_queue) return; last_queue = key;
  const container = by_id('message-queue'); container.replaceChildren(); container.hidden = queue.length === 0;
  if (queue.length) {
    const heading = document.createElement('div'); heading.className = 'queued-heading'; const label = document.createElement('span'); label.textContent = `待发送 · ${queue.length}`; heading.append(label);
    const resume = document.createElement('button'); resume.id = 'resume-queue'; resume.className = 'text-button'; resume.textContent = '继续队列'; resume.hidden = Boolean(state?.busy); resume.disabled = !state?.connected || !state.authenticated;
    resume.onclick = () => { void act({ type: 'resume_queue' }); }; heading.append(resume); container.append(heading);
  }
  for (const [index, message] of queue.entries()) {
    const row = document.createElement('div'); row.className = 'queued-message'; row.innerHTML = icon('chat');
    const text = document.createElement('span'); text.textContent = `${index + 1}. ${message.text}`; text.title = message.text;
    const remove = document.createElement('button'); remove.className = 'icon-button'; remove.innerHTML = icon('close'); remove.ariaLabel = `移除队列消息 ${index + 1}`;
    remove.onclick = () => { void act({ type: 'remove_queued', id: message.id }); }; row.append(text, remove); container.append(row);
  }
}
/** @brief 呈现最近的消息，保留滚动位置与已经展开的工具详情。 */
function render_messages(): void {
  if (!state) return; const target = by_id('conversation'); const bottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 70; const old_scroll = target.scrollTop;
  const opened_tools = new Set([...target.querySelectorAll<HTMLElement>('.message.tool')].filter(row => row.querySelector('details')?.open).map(row => row.dataset.message_id));
  const fragment = document.createDocumentFragment();
  if (state.messages.length > 150) { const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = '显示最近 150 条消息，完整会话可通过导出查看。'; fragment.append(hint); }
  for (const message of state.messages.slice(-150)) {
    const row = document.createElement('article'); row.className = `message ${message.role}`; row.dataset.message_id = message.id;
    if (message.role === 'tool') {
      const detail = document.createElement('details'); detail.open = opened_tools.has(message.id); const summary = document.createElement('summary'); summary.innerHTML = icon('terminal'); const text = document.createElement('span'); text.textContent = message.text.split('\n')[0]?.slice(0, 110) || '工具活动'; summary.append(text);
      const pre = document.createElement('pre'); pre.textContent = message.text; detail.append(summary, pre); row.append(detail);
    } else {
      if (message.role !== 'system') { const label = document.createElement('div'); label.className = 'message-label'; label.innerHTML = message.role === 'assistant' ? `${icon('spark')} AI CODE` : '你'; row.append(label); }
      const content = document.createElement('div'); content.className = 'message-content'; if (message.role === 'assistant') content.innerHTML = markdown(message.text); else content.textContent = message.text; row.append(content);
    }
    fragment.append(row);
  }
  target.replaceChildren(fragment); if (bottom) target.scrollTop = target.scrollHeight; else target.scrollTop = old_scroll;
}
function render_sessions(): void {
  if (!state) return; const target = by_id('session-list'); target.replaceChildren();
  if (!state.sessions.length) { const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = '暂无会话'; target.append(hint); return; }
  for (const session of state.sessions) {
    const node = document.createElement('button'); node.className = `session${session.id === state.thread_id ? ' active' : ''}`; node.innerHTML = icon('chat'); node.title = session.title;
    const title = document.createElement('span'); title.textContent = session.title || '未命名会话'; node.append(title); node.disabled = state.busy || state.session_loading;
    node.onclick = () => { ++context_epoch; close_preview(); attachments = []; render_attachments(); void act({ type: 'resume', id: session.id }); }; target.append(node);
  }
}
function render_pickers(): void {
  if (!state) return; const models = by_id('model-menu'); models.replaceChildren();
  for (const model of state.models) {
    const node = document.createElement('button'); node.role = 'option'; node.setAttribute('aria-selected', String(model.id === state.model)); node.classList.toggle('selected', model.id === state.model);
    const name = document.createElement('span'); name.textContent = model.name; node.append(name);
    if (model.description) { const desc = document.createElement('small'); desc.textContent = model.description; node.append(desc); }
    node.onclick = () => { close_menus(); void act({ type: 'set_model', id: model.id }); }; models.append(node);
  }
  if (!state.models.length) { const note = document.createElement('div'); note.className = 'empty-hint'; note.textContent = '登录后读取可用模型'; models.append(note); }
  const modes = by_id('mode-menu'); modes.replaceChildren();
  for (const [id, title, description] of [['read-only', '只读聊天', '分析和读取项目，保持文件不变'], ['workspace-write', '项目智能体', '允许修改项目文件，操作按需审批']] as const) {
    const node = document.createElement('button'); node.role = 'option'; node.setAttribute('aria-selected', String(state.mode === id)); node.classList.toggle('selected', state.mode === id); node.disabled = id === 'workspace-write' && !state.cwd;
    const name = document.createElement('span'); name.textContent = title; const desc = document.createElement('small'); desc.textContent = node.disabled ? '打开项目文件夹后可用' : description; node.append(name, desc); node.onclick = () => { close_menus(); void act({ type: 'set_mode', mode: id }); }; modes.append(node);
  }
}
function close_menus(): void { for (const name of ['model', 'mode']) { by_id(`${name}-menu`).hidden = true; button(`${name}-picker`).setAttribute('aria-expanded', 'false'); } by_id('project-menu').hidden = true; button('open-project').setAttribute('aria-expanded', 'false'); by_id('response-menu').hidden = true; button('response-options').setAttribute('aria-expanded', 'false'); }
/** @brief 取得当前命名项目；旧会话的单目录可以没有项目配置。 */
function current_project(): project_info | undefined { const current = state; return current?.project_catalog?.find(project => project.id === current.active_project_id); }
/** @brief 取得已验证的全部工作目录，兼容旧版本的单目录会话。 */
function project_roots(): string[] { return state?.workspace_roots ?? (state?.cwd ? [state.cwd] : []); }

/** @brief 根据项目名称搜索并呈现可切换的项目，名称始终作为纯文本。 */
function render_project_menu(): void {
  if (!state) return;
  const query = by_id<HTMLInputElement>('project-search').value.trim().toLocaleLowerCase();
  const working = state.busy || state.session_loading;
  const key = JSON.stringify([state.project_catalog, state.active_project_id, query, working]);
  if (key === last_projects) return; last_projects = key;
  const list = by_id('project-list'); list.replaceChildren();
  const matches = (state.project_catalog || []).filter(project => project.name.toLocaleLowerCase().includes(query));
  for (const project of matches) {
    const row = document.createElement('button'); row.role = 'option'; row.className = 'project-option'; row.disabled = working;
    const selected = project.id === state.active_project_id; row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
    row.innerHTML = icon('folder'); const name = document.createElement('span'); name.textContent = project.name; row.append(name);
    if (selected) { const check = document.createElement('span'); check.className = 'project-check'; check.innerHTML = icon('check'); row.append(check); }
    row.title = project.directories.length ? project.directories.join('\n') : '此项目尚未添加目录';
    row.onclick = () => { close_menus(); void act({ type: 'select_project', id: project.id }); }; list.append(row);
  }
  if (!matches.length) { const empty = document.createElement('div'); empty.className = 'project-empty'; empty.textContent = query ? '没有匹配的项目' : '暂无项目'; list.append(empty); }
  by_id('manage-project').hidden = !current_project();
}

/** @brief 用统一弹窗编辑项目名称及多个目录，保存前只维护本地草稿。
 * @param project 已有项目；省略时创建新项目。
 */
function edit_project(project?: project_info): void {
  close_menus();
  const draft = { id: project?.id, name: project?.name || '', directories: [...(project?.directories || [])] };
  const draw = () => {
    const view = modal(draft.id ? '管理项目' : '新建项目', 'project-dialog');
    const name_label = document.createElement('label'); name_label.className = 'project-name-label'; name_label.textContent = '项目名称';
    const name = document.createElement('input'); name.id = 'project-name'; name.maxLength = 80; name.value = draft.name; name.placeholder = '例如：work'; name.ariaLabel = '项目名称'; name.oninput = () => { draft.name = name.value; }; name_label.append(name);
    const label = document.createElement('div'); label.className = 'project-directory-label'; label.textContent = '项目目录';
    const directories = document.createElement('div'); directories.className = 'project-directories';
    for (const directory of draft.directories) {
      const row = document.createElement('div'); row.className = 'project-directory-row'; row.innerHTML = icon('folder');
      const text = document.createElement('span'); text.textContent = directory; text.title = directory; row.append(text);
      const remove = document.createElement('button'); remove.className = 'icon-button'; remove.innerHTML = icon('close'); remove.ariaLabel = `移除目录 ${basename(directory)}`;
      remove.onclick = () => { draft.name = name.value; draft.directories = draft.directories.filter(item => item !== directory); view.close(); draw(); }; row.append(remove); directories.append(row);
    }
    if (!draft.directories.length) { const empty = document.createElement('p'); empty.className = 'profile-note'; empty.textContent = '尚未添加目录，左侧将不显示目录栏。'; directories.append(empty); }
    const add = dialog_button('添加目录'); add.id = 'add-project-directory'; add.disabled = draft.directories.length >= 16;
    add.onclick = () => {
      draft.name = name.value; view.close();
      void pick_path('folder').then(directory => {
        if (directory && !draft.directories.some(item => item.toLocaleLowerCase() === directory.toLocaleLowerCase())) draft.directories.push(directory);
        if (by_id('modal-layer').hidden) draw();
      }).catch(error => toast(error_text(error)));
    };
    const note = document.createElement('p'); note.className = 'profile-note'; note.textContent = '最多 16 个目录，命令默认在第一个目录执行。移除目录不会删除文件。';
    const error = document.createElement('div'); error.className = 'project-editor-error'; error.role = 'alert';
    view.body.append(name_label, label, directories, add, note, error);
    if (draft.id) {
      const remove = dialog_button('删除项目'); remove.className += ' delete-project';
      remove.onclick = () => { view.close(); void confirm_dialog('删除项目配置', `删除“${draft.name}”的项目配置？磁盘上的目录和文件会保留。`, '删除项目').then(async accepted => { if (accepted) await invoke({ type: 'delete_project', id: draft.id! }); else if (by_id('modal-layer').hidden) draw(); }).catch(error => toast(error_text(error))); };
      view.actions.append(remove);
    }
    const cancel = dialog_button('取消'); cancel.onclick = view.close;
    const save = dialog_button(draft.id ? '保存' : '创建项目', true); save.id = 'save-project';
    save.onclick = () => {
      draft.name = name.value.trim(); if (!draft.name) { error.textContent = '请输入项目名称。'; name.focus(); return; }
      save.disabled = true; add.disabled = true;
      void invoke({ type: 'save_project', ...(draft.id ? { id: draft.id } : {}), name: draft.name, directories: draft.directories }).then(() => view.close()).catch(failure => { error.textContent = error_text(failure); save.disabled = false; add.disabled = draft.directories.length >= 16; });
    };
    view.actions.append(cancel, save); setTimeout(() => name.focus(), 0);
  };
  draw();
}
/** @brief 刷新当前项目根目录，并忽略项目切换前的异步结果。 */
async function refresh_tree(): Promise<void> {
  if (!state) return;
  const roots = project_roots(); const epoch = context_epoch;
  const target = by_id('file-tree'); target.replaceChildren();
  by_id('files-section').hidden = roots.length === 0;
  for (const root of roots) {
    const section = document.createElement('section'); section.className = 'directory-section'; section.title = root;
    const heading = document.createElement('div'); heading.className = 'section-heading';
    const toggle = document.createElement('button'); toggle.className = 'section-toggle directory-toggle'; toggle.innerHTML = `<span class="chevron">${icon('chevron')}</span>`;
    const title = document.createElement('span'); title.textContent = basename(root) || root; toggle.append(title); heading.append(toggle);
    const reload = document.createElement('button'); reload.className = 'icon-button directory-refresh'; reload.innerHTML = icon('refresh'); reload.title = '刷新此目录'; reload.ariaLabel = `刷新 ${title.textContent}`; heading.append(reload);
    const content = document.createElement('div'); content.className = 'directory-content';
    section.append(heading, content); target.append(section);
    const storage_key = `directory_expanded:${state.active_project_id || ''}:${root}`;
    let expanded = false; try { expanded = localStorage.getItem(storage_key) === 'true'; } catch { /* Default to collapsed. */ }
    let loaded = false; let sequence = 0;
    const expand = () => { toggle.setAttribute('aria-expanded', String(expanded)); section.classList.toggle('expanded', expanded); content.hidden = !expanded; };
    const load = async () => {
      const request = ++sequence; reload.disabled = true;
      try { const listing = await invoke<directory_listing>({ type: 'list_directory', path: root, project_only: true }); if (epoch !== context_epoch || request !== sequence || !section.isConnected) return; content.replaceChildren(); draw_tree(content, listing); loaded = true; }
      catch (error) { if (epoch !== context_epoch || request !== sequence || !section.isConnected) return; const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = error_text(error); content.replaceChildren(hint); }
      finally { if (request === sequence) reload.disabled = false; }
    };
    toggle.onclick = () => { expanded = !expanded; expand(); try { localStorage.setItem(storage_key, String(expanded)); } catch { /* Folding remains available without storage. */ } if (expanded && !loaded) void load(); };
    reload.onclick = () => { expanded = true; expand(); void load(); };
    expand(); if (expanded) void load();
  }
}
/** @brief 渲染一层目录，子目录仅在首次展开时读取。
 * @param target 该层目录对应的 DOM 容器。
 * @param listing 主进程验证后的目录结果。
 */
function draw_tree(target: HTMLElement, listing: directory_listing): void {
  if (!listing.entries.length) { const hint = document.createElement('div'); hint.className = 'empty-hint'; hint.textContent = '文件夹为空'; target.append(hint); }
  for (const entry of listing.entries) {
    const row = document.createElement('button'); row.className = 'tree-row'; row.title = entry.path;
    const chevron = document.createElement('span'); chevron.className = 'tree-chevron'; if (entry.directory) chevron.innerHTML = icon('chevron');
    const glyph = document.createElement('span'); glyph.className = entry.directory ? 'folder-icon' : 'file-icon'; glyph.innerHTML = icon(entry.directory ? 'folder' : 'file'); const name = document.createElement('span'); name.textContent = entry.name; row.append(chevron, glyph, name); target.append(row);
    if (entry.directory) {
      const children = document.createElement('div'); children.className = 'tree-children'; children.hidden = true; target.append(children); row.setAttribute('aria-expanded', 'false'); let loaded = false;
      row.onclick = async () => { children.hidden = !children.hidden; row.setAttribute('aria-expanded', String(!children.hidden)); if (!children.hidden && !loaded) { row.disabled = true; try { const next = await invoke<directory_listing>({ type: 'list_directory', path: entry.path, project_only: true }); draw_tree(children, next); loaded = true; } catch (error) { toast(error_text(error)); } finally { row.disabled = false; } } };
    } else row.onclick = () => { void preview_file(entry.path); };
  }
  if (listing.truncated) { const note = document.createElement('div'); note.className = 'empty-hint'; note.textContent = '条目过多，仅显示部分文件'; target.append(note); }
}
/** @brief 打开文件的只读预览，拒绝过期请求覆盖新项目或新选择。
 * @param path 当前项目中文件的绝对路径。
 */
async function preview_file(path: string): Promise<void> { const request = ++preview_request; const epoch = context_epoch; try { const result = await invoke<file_preview>({ type: 'read_file', path }); if (request !== preview_request || epoch !== context_epoch) return; by_id('preview-name').textContent = basename(result.path); by_id('preview-name').title = result.path; by_id('preview-code').textContent = result.content; by_id('preview-note').textContent = result.truncated ? '只读预览 · 已截取前 256 KiB' : '只读预览'; by_id('file-preview').hidden = false; } catch (error) { if (request === preview_request && epoch === context_epoch) toast(error_text(error)); } }
function close_preview(): void { ++preview_request; by_id('file-preview').hidden = true; }
/** @brief 使用统一界面浏览目录、选择项目文件或确认导出路径。
 * @param kind folder 选择项目，file 选择上下文文件，save 选择导出位置，avatar 选择本地头像。
 * @returns 用户选择的绝对路径；取消时不返回路径。
 */
async function pick_path(kind: 'folder' | 'save' | 'file' | 'avatar'): Promise<string | undefined> {
  if (!state) return;
  const choosing_file = kind === 'file' || kind === 'avatar';
  const initial_path = kind === 'avatar' ? '' : state.cwd;
  return new Promise(resolve => {
    const view = modal(kind === 'folder' ? '打开项目' : kind === 'save' ? '导出会话' : kind === 'avatar' ? '选择本地头像' : '添加项目文件', 'path-dialog'); view.body.remove();
    const pathbar = document.createElement('div'); pathbar.className = 'modal-pathbar'; const up = dialog_button('上一级'); const input = document.createElement('input'); input.className = 'path-input'; input.ariaLabel = '文件夹路径'; input.value = initial_path; const go = dialog_button('前往'); pathbar.append(up, input, go);
    const list = document.createElement('div'); list.className = 'path-list'; list.role = 'list';
    const name_row = document.createElement('label'); name_row.className = 'path-name'; name_row.append('文件名'); const name = document.createElement('input'); name.ariaLabel = '文件名'; name.value = 'ai-code-conversation.md'; name_row.append(name); name_row.hidden = kind !== 'save';
    const note = document.createElement('div'); note.className = 'path-error'; note.role = 'status';
    view.element.insertBefore(pathbar, view.actions); view.element.insertBefore(list, view.actions); view.element.insertBefore(name_row, view.actions); view.element.insertBefore(note, view.actions);
    const cancel = dialog_button('取消'); const accept = dialog_button(kind === 'folder' ? '选择此文件夹' : kind === 'save' ? '保存' : kind === 'avatar' ? '使用此图片' : '添加文件', true); view.actions.append(cancel, accept);
    let listing: directory_listing | undefined; let selected: directory_entry | undefined; let sequence = 0; let done = false;
    const finish = (path?: string) => { if (done) return; done = true; sequence++; view.close(); resolve(path); };
    cancel.onclick = () => finish(); view.cancel(() => finish());
    async function load(path: string): Promise<void> {
      const id = ++sequence; accept.disabled = true; go.disabled = true; up.disabled = true; note.textContent = '正在读取…'; selected = undefined; listing = undefined; list.replaceChildren();
      try {
        const next = await invoke<directory_listing>({ type: 'list_directory', path, project_only: kind === 'file' }); if (id !== sequence || done) return;
        listing = next; input.value = next.path; list.replaceChildren();
        for (const entry of next.entries.filter(item => item.directory || (kind !== 'folder' && (kind !== 'avatar' || /\.(png|jpe?g)$/i.test(item.name))))) {
          const row = document.createElement('button'); row.className = `path-row${entry.directory ? ' directory' : ''}`; row.innerHTML = icon(entry.directory ? 'folder' : 'file'); const title = document.createElement('span'); title.textContent = entry.name; row.append(title); row.title = entry.path;
          row.onclick = () => { selected = entry; list.querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); row.classList.add('selected'); if (kind === 'save' && !entry.directory) name.value = entry.name; accept.disabled = choosing_file ? entry.directory : kind === 'save' ? !listing?.path : !entry.directory && !listing?.path; };
          row.ondblclick = () => { if (entry.directory) void load(entry.path); else if (choosing_file) finish(entry.path); };
          row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); if (entry.directory) void load(entry.path); else if (choosing_file) finish(entry.path); } }; list.append(row);
        }
        note.textContent = next.truncated ? '目录内容较多，仅显示部分条目。' : kind === 'avatar' ? 'PNG 或 JPEG，最大 5 MiB；图片会居中裁剪，仅保存在本机。' : kind === 'file' ? '选择项目中的文本文件，作为这条消息的上下文。' : '双击进入文件夹，也可在地址栏输入路径。'; accept.disabled = choosing_file || !next.path; up.disabled = next.parent === next.path;
      } catch (error) { if (id === sequence) { note.textContent = error_text(error); accept.disabled = true; } }
      finally { if (id === sequence) go.disabled = false; }
    }
    go.onclick = () => { void load(input.value.trim()); }; input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void load(input.value.trim()); } }; up.onclick = () => { if (listing) void load(listing.parent); };
    accept.onclick = () => { if (!listing) return; if (kind === 'folder') { const selection = selected?.directory ? selected.path : listing.path; if (selection) finish(selection); } else if (choosing_file && selected && !selected.directory) finish(selected.path); else if (kind === 'save' && listing.path) { const filename = name.value.trim(); if (!filename || /[<>:"/\\|?*\u0000-\u001f]/.test(filename) || /^\.+$/.test(filename) || /[. ]$/.test(filename)) { note.textContent = '请输入有效的文件名。'; return; } finish(join_path(listing.path, filename)); } };
    void load(initial_path); setTimeout(() => input.focus(), 0);
  });
}
function render_attachments(): void {
  const target = by_id('attachments'); target.replaceChildren(); for (const [index, item] of attachments.entries()) { const chip = document.createElement('span'); chip.className = 'attachment'; chip.innerHTML = icon('file'); const title = document.createElement('span'); title.textContent = basename(item.path); const remove = document.createElement('button'); remove.innerHTML = icon('close'); remove.ariaLabel = `移除 ${basename(item.path)}`; remove.onclick = () => { attachments.splice(index, 1); render_attachments(); }; chip.append(title, remove); target.append(chip); } update_send();
}
/** @brief 发送当前草稿和显式附件，或停止正在生成的回复。
 * @details 草稿在接收成功且内容未改变时才清空，提交期间仍允许编辑。
 */
async function send(): Promise<void> {
  if (!state || button('send').disabled) return; if (state.busy) { await act({ type: 'stop' }); return; }
  if (submission_pending) return;
  const raw = prompt.value; const epoch = context_epoch;
  const text = raw.trim(); const files = [...attachments]; const full = text + files.map(file => `\n\n附加文件：${file.path}${file.truncated ? '（已截取）' : ''}\n\`\`\`\n${file.content}\n\`\`\``).join('');
  if (full.length > 64_000) { toast('消息与附加文件合计不能超过 64,000 个字符，请缩短消息或移除部分文件。'); return; }
  submission_pending = true; update_send();
  try {
    await invoke({ type: 'send', text: full });
    if (epoch === context_epoch && prompt.value === raw && attachments.length === files.length && attachments.every((file, index) => file === files[index])) {
      prompt.value = ''; attachments = []; render_attachments(); prompt.style.height = '';
    }
  } catch (error) { toast(error_text(error)); }
  finally { submission_pending = false; update_send(); prompt.focus(); }
}
/** @brief 发送生成期间的后续指令，只有成功接管且草稿未变化时才清空输入。
 * @param type 停止后发送、排队、实时引导或独立侧边会话。
 */
async function submit_follow_up(type: 'stop_and_send' | 'queue_message' | 'steer_message' | 'side_chat'): Promise<void> {
  if (!state?.busy || submission_pending || state.stopping || !state.connected || !state.authenticated) return;
  const raw = prompt.value; const files = [...attachments]; const epoch = context_epoch;
  const text = raw.trim() + files.map(file => `\n\n附加文件：${file.path}${file.truncated ? '（已截取）' : ''}\n\`\`\`\n${file.content}\n\`\`\``).join('');
  if (!text.trim()) return;
  if (text.length > 64_000) { toast('消息与附加文件合计不能超过 64,000 个字符。'); return; }
  submission_pending = true; close_menus(); update_send();
  try {
    await invoke({ type, text });
    if (epoch === context_epoch && prompt.value === raw && attachments.length === files.length && attachments.every((file, index) => file === files[index])) {
      prompt.value = ''; attachments = []; render_attachments(); prompt.style.height = '';
    }
    if (type === 'queue_message') toast('已添加到队列');
    else if (type === 'steer_message') toast('已发送引导消息');
    else if (type === 'side_chat') toast('已在独立侧边会话中打开');
  } catch (error) { toast(error_text(error)); }
  finally { submission_pending = false; update_send(); prompt.focus(); }
}
/** @brief 同步标题栏、侧栏及账号弹窗的头像和真实登录状态。 */
function render_profile(): void {
  if (!state) return;
  const owner = avatar_owner(state);
  if (owner !== avatar_identity) { avatar_identity = owner; avatar_value = read_avatar_preference(owner); }
  for (const id of ['title-avatar', 'sidebar-avatar', 'profile-avatar']) {
    const target = document.getElementById(id); if (target) render_avatar(target, avatar_value);
  }
  const status = state.login_pending ? '正在登录' : state.connecting ? '正在连接服务' : !state.connected ? '服务未连接' : state.authenticated ? '已登录 ChatGPT' : '尚未登录';
  button('title-account').title = `${state.authenticated ? state.account : 'ChatGPT 账号'} · ${status}`;
  button('title-account').ariaLabel = `账号与头像，${status}`;
  by_id('avatar-status').hidden = state.connected && state.authenticated && !state.login_pending;
  by_id('avatar-status').classList.toggle('pending', state.login_pending || state.connecting);
  const name = document.getElementById('profile-name'); if (name) name.textContent = state.account || 'ChatGPT 账号';
  const quota = document.getElementById('profile-quota'); if (quota) quota.textContent = state.quota || status;
  const note = document.getElementById('profile-note');
  if (note) note.textContent = owner === 'session' ? '本次登录未提供邮箱，头像仅在当前登录期间显示。' : '头像仅保存在本机，按账号独立保存。未登录时使用单独的默认配置。';
  const reset = document.getElementById('clear-avatar') as HTMLButtonElement | null; if (reset) reset.disabled = !avatar_value;
  const login = document.getElementById('profile-login') as HTMLButtonElement | null;
  if (login) { login.textContent = state.login_pending ? '取消登录' : state.authenticated ? '退出账号' : '登录 ChatGPT'; login.disabled = state.busy || state.session_loading || (!state.connected && !state.preview); }
}

/** @brief 从统一文件选择器读取头像，账号切换或更新操作会使旧请求失效。 */
async function choose_avatar(): Promise<void> {
  if (!state) return;
  const owner = avatar_owner(state); const sequence = ++avatar_sequence;
  try {
    const path = await pick_path('avatar');
    if (!path || sequence !== avatar_sequence || owner !== avatar_owner(state)) return;
    const value = await invoke<string>({ type: 'read_avatar', path });
    if (sequence !== avatar_sequence || owner !== avatar_owner(state)) return;
    write_avatar_preference(owner, value); avatar_value = value; render_profile(); toast('本地头像已更新');
  } finally {
    if (sequence === avatar_sequence && owner === avatar_owner(state) && by_id('modal-layer').hidden) open_account();
  }
}

/** @brief 打开统一的账号弹窗，提供本机头像选择、恢复及登录入口。 */
function open_account(): void {
  if (!state) return;
  close_menus(); const view = modal('账号与头像', 'account-dialog');
  const heading = document.createElement('div'); heading.className = 'profile-heading';
  const picture = document.createElement('span'); picture.id = 'profile-avatar'; picture.className = 'avatar-picture profile-avatar';
  const details = document.createElement('div'); details.className = 'profile-details';
  const name = document.createElement('div'); name.id = 'profile-name'; name.className = 'profile-name';
  const quota = document.createElement('div'); quota.id = 'profile-quota'; quota.className = 'profile-quota'; details.append(name, quota); heading.append(picture, details);
  const options = document.createElement('div'); options.className = 'profile-options';
  const choose = dialog_button('更换本地头像'); choose.id = 'choose-avatar';
  const reset = dialog_button('恢复默认'); reset.id = 'clear-avatar'; options.append(choose, reset);
  const note = document.createElement('p'); note.id = 'profile-note'; note.className = 'profile-note';
  view.body.append(heading, options, note);
  choose.onclick = () => { view.close(); void choose_avatar().catch(error => toast(error_text(error))); };
  reset.onclick = () => { try { ++avatar_sequence; write_avatar_preference(avatar_owner(state!), ''); avatar_value = ''; render_profile(); } catch (error) { toast(error_text(error)); } };
  const login = dialog_button('登录 ChatGPT'); login.id = 'profile-login';
  login.onclick = () => { view.close(); button('login').click(); };
  const done = dialog_button('完成', true); done.onclick = view.close; view.actions.append(login, done); render_profile();
}
/** @brief 注册工作台交互并恢复侧栏展开状态与宽度偏好。 */
function initialize(): void {
  if (side_chat_mode) { document.querySelector('.brand>span:last-child')!.textContent = '侧边聊天'; document.title = 'AI Code · 侧边聊天'; }
  on('title-account', open_account);
  on('response-options', () => { const visible = by_id('response-menu').hidden; close_menus(); by_id('response-menu').hidden = !visible; button('response-options').setAttribute('aria-expanded', String(visible)); if (visible) by_id('response-menu').querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); });
  for (const [id, type] of [['stop-and-send', 'stop_and_send'], ['queue-message', 'queue_message'], ['steer-message', 'steer_message'], ['side-chat', 'side_chat']] as const) on(id, () => submit_follow_up(type));
  by_id('response-menu').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { close_menus(); button('response-options').focus(); return; }
    const choices = [...by_id('response-menu').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = choices.indexOf(document.activeElement as HTMLButtonElement); choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
  });
  for (const kind of ['sessions']) {
    const expanded = localStorage.getItem(`expanded-${kind}`) !== 'false'; by_id(`${kind}-section`).classList.toggle('expanded', expanded); by_id(`${kind}-content`).hidden = !expanded; button(`toggle-${kind}`).setAttribute('aria-expanded', String(expanded));
    on(`toggle-${kind}`, () => { const next = !by_id(`${kind}-section`).classList.contains('expanded'); by_id(`${kind}-section`).classList.toggle('expanded', next); by_id(`${kind}-content`).hidden = !next; button(`toggle-${kind}`).setAttribute('aria-expanded', String(next)); localStorage.setItem(`expanded-${kind}`, String(next)); });
  }
  const resize = (width: number) => { const value = Math.max(205, Math.min(380, width)); document.documentElement.style.setProperty('--side-width', `${value}px`); localStorage.setItem('sidebar-width', String(value)); };
  const saved = Number(localStorage.getItem('sidebar-width')); if (saved) resize(saved);
  const resizer = by_id('sidebar-resizer'); resizer.onpointerdown = event => { resizer.setPointerCapture(event.pointerId); resizer.classList.add('dragging'); }; resizer.onpointermove = event => { if (resizer.hasPointerCapture(event.pointerId)) resize(event.clientX); }; resizer.onpointerup = event => { resizer.releasePointerCapture(event.pointerId); resizer.classList.remove('dragging'); }; resizer.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(by_id('sidebar').getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -10 : 10)); } };
  on('new-chat', () => { ++context_epoch; close_preview(); attachments = []; render_attachments(); prompt.focus(); return act({ type: 'new_chat' }); });
  on('refresh', () => act({ type: 'refresh' })); on('reconnect', () => act({ type: 'connect' }));
  on('show-diff', () => { ++preview_request; by_id('preview-name').textContent = '当前回合的文件更改'; by_id('preview-name').title = ''; by_id('preview-note').textContent = '只读差异预览'; by_id('preview-code').textContent = state?.diff || ''; by_id('file-preview').hidden = false; });
  on('login', async () => { if (state?.login_pending) await act({ type: 'cancel_login' }); else if (state?.authenticated) { if (await confirm_dialog('退出 ChatGPT', '退出后需要重新登录才能继续对话。历史会话仍保留在此客户端。', '退出账号')) await act({ type: 'logout' }); } else await act({ type: 'login' }); });
  on('open-project', () => { const visible = by_id('project-menu').hidden; close_menus(); by_id('project-menu').hidden = !visible; button('open-project').setAttribute('aria-expanded', String(visible)); if (visible) { by_id<HTMLInputElement>('project-search').value = ''; render_project_menu(); by_id('project-search').focus(); } });
  by_id('project-search').addEventListener('input', render_project_menu);
  on('new-project', () => edit_project()); on('manage-project', () => { const project = current_project(); if (project) edit_project(project); });
  on('leave-project', () => { close_menus(); return act({ type: 'select_project', id: '' }); });
  by_id('project-menu').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { close_menus(); button('open-project').focus(); return; }
    const options = [...by_id('project-menu').querySelectorAll<HTMLElement>('input,button:not(:disabled)')].filter(element => !element.hidden && element.getClientRects().length);
    const index = options.indexOf(document.activeElement as HTMLElement); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  });
  for (const name of ['model', 'mode']) on(`${name}-picker`, () => { const visible = by_id(`${name}-menu`).hidden; close_menus(); by_id(`${name}-menu`).hidden = !visible; button(`${name}-picker`).setAttribute('aria-expanded', String(visible)); if (visible) by_id(`${name}-menu`).querySelector<HTMLButtonElement>('button')?.focus(); });
  document.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.picker-anchor')) close_menus(); });
  document.addEventListener('keydown', event => { if (!by_id('modal-layer').hidden) return; if (event.key === 'Escape') { close_menus(); close_preview(); prompt.focus(); } if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!button('new-chat').disabled) button('new-chat').click(); } });
  for (const name of ['model', 'mode']) by_id(`${name}-menu`).addEventListener('keydown', event => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault(); const options = [...by_id(`${name}-menu`).querySelectorAll<HTMLButtonElement>('button')]; const current = options.indexOf(document.activeElement as HTMLButtonElement); options[(current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); });
  prompt.addEventListener('input', () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 210)}px`; update_send(); });
  prompt.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    if (state?.busy) { event.preventDefault(); void submit_follow_up(event.altKey ? 'queue_message' : event.ctrlKey ? 'stop_and_send' : 'steer_message'); }
    else if (event.ctrlKey) { event.preventDefault(); void send(); }
  }); on('send', send); on('close-preview', close_preview);
  on('attach', async () => { const epoch = context_epoch; const path = await pick_path('file'); if (!path || epoch !== context_epoch) return; if (attachments.some(item => item.path === path)) { toast('此文件已经添加'); return; } const file = await invoke<file_preview>({ type: 'read_file', path }); if (epoch !== context_epoch) return; if (file.content.length > 32_000) { file.content = file.content.slice(0, 32_000); file.truncated = true; } attachments.push(file); render_attachments(); prompt.focus(); });
  on('copy-reply', async () => { const message = state?.messages.findLast(m => m.role === 'assistant'); if (message) { await invoke({ type: 'copy', text: message.text }); toast('已复制回复'); } });
  on('export', async () => { const path = await pick_path('save'); if (!path) return; let result = await invoke<export_result>({ type: 'export_conversation', path, overwrite: false }); if (result.exists) { if (!await confirm_dialog('替换已有文件', `此文件已存在：\n${path}\n\n保存将替换其内容。`, '替换文件')) return; result = await invoke<export_result>({ type: 'export_conversation', path, overwrite: true }); } toast(`已导出到 ${result.path}`); });
  on('about', async () => { const view = modal('关于 AI Code'); view.body.textContent = 'AI Code\n\nElectron + Chromium + TypeScript\n\n通过 OpenAI 官方 Codex 服务连接 ChatGPT 账号，使用订阅包含的 Codex 额度，无需 API Key。\n\n登录在独立的内置窗口中进行。身份提供方可能限制嵌入式登录；客户端不会自动跳转外部浏览器。\n\nCtrl+Enter 发送消息 · Ctrl+N 新建会话\n\n这是自建客户端，与 OpenAI 官方客户端无隶属关系。'; const okay = dialog_button('知道了', true); okay.onclick = view.close; view.actions.append(okay); });
}
