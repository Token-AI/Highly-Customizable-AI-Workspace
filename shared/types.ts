/** @file types.ts
 * @brief 主进程与渲染进程共享的受限 IPC 契约。
 * @details 自定义标识符使用 snake_case；Codex 线协议在后端边界显式转换。
 */

/** @brief 对应服务端沙箱能力的工作模式。 */
export type mode = 'read-only' | 'workspace-write';
/** @brief 一条可呈现或导出的对话消息。 */
export interface chat_message { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }
/** @brief 侧栏中的历史会话摘要。 */
export interface chat_session { id: string; title: string; updated_at?: number }
/** @brief 官方服务动态返回的模型目录项。 */
export interface model_info { id: string; name: string; description?: string }
/** @brief 仅包含名称和显式目录列表的项目定义，不包含当前选择或账号信息。 */
export interface project_info { id: string; name: string; directories: string[] }
/** @brief 可传给本地界面的状态快照，不包含登录令牌或认证 URL。 */
export interface app_state {
  connected: boolean; connecting: boolean; authenticated: boolean; login_pending: boolean;
  busy: boolean; stopping: boolean; session_loading: boolean; preview: boolean;
  account: string; quota: string; status: string; error: string;
  /** @brief 后端确认的当前账号邮箱；缺失时不持久保存账号专属头像。 */
  account_email?: string;
  /** @brief 用户明确打开的项目绝对路径；空字符串表示未打开项目。 */
  cwd: string;
  /** @brief 已保存的项目定义；启动时只加载列表，不自动选择项目。 */
  project_catalog?: project_info[];
  active_project_id?: string;
  /** @brief 当前项目的独立读取边界，首项与 cwd 对应；不得合并成公共父目录。 */
  workspace_roots?: string[];
  /** @brief 等待当前回复结束后发送的本地队列消息。 */
  queued_messages?: { id: string; text: string }[];
  model: string; mode: mode; models: model_info[];
  thread_id: string; messages: chat_message[]; sessions: chat_session[]; diff: string;
}
/** @brief 仅本次操作有效的审批请求，不代表持久授权。 */
export interface approval { id: string; title: string; detail: string }
/** @brief 主进程主动发送给本地窗口的事件集合。 */
export type app_event = { type: 'state'; state: app_state }
  | { type: 'approval'; approval: approval }
  | { type: 'auth'; origin: string; error?: string }
  | { type: 'draft'; text: string; acknowledge?: boolean }
  | { type: 'draft_sent'; text: string }
  | { type: 'close_requested' }
  | { type: 'window'; maximized: boolean };
/** @brief 已过滤符号链接的目录项。 */
export interface directory_entry { name: string; path: string; directory: boolean }
/** @brief 限制条目数量的目录读取结果；path/parent 为空表示虚拟磁盘入口。 */
export interface directory_listing { path: string; parent: string; entries: directory_entry[]; truncated: boolean }
/** @brief 已验证编码并限制大小的只读文件内容。 */
export interface file_preview { path: string; content: string; truncated: boolean }
/** @brief 界面允许请求的操作白名单，主进程仍须逐项验证参数。 */
export type app_action =
  | { type: 'ready' } | { type: 'connect' } | { type: 'login' } | { type: 'cancel_login' }
  | { type: 'logout' } | { type: 'refresh' } | { type: 'new_chat' }
  | { type: 'send'; text: string } | { type: 'stop' } | { type: 'resume'; id: string }
  | { type: 'queue_message' | 'steer_message' | 'stop_and_send'; text: string }
  | { type: 'remove_queued'; id: string }
  | { type: 'resume_queue' }
  | { type: 'side_chat'; text: string }
  | { type: 'draft_ready'; text: string }
  | { type: 'set_model'; id: string } | { type: 'set_mode'; mode: mode }
  | { type: 'set_project'; path: string } | { type: 'approve'; id: string; accept: boolean }
  | { type: 'save_project'; id?: string; name: string; directories: string[] }
  | { type: 'select_project'; id: string }
  | { type: 'delete_project'; id: string }
  | { type: 'list_directory'; path: string; project_only?: boolean }
  | { type: 'read_file'; path: string }
  /** @brief 读取明确选择的本地头像，无需项目；返回 128×128 PNG data URL。 */
  | { type: 'read_avatar'; path: string }
  | { type: 'export_conversation'; path: string; overwrite: boolean }
  | { type: 'copy'; text: string }
  | { type: 'window'; command: 'minimize' | 'maximize' | 'close' };
/** @brief 导出结果；exists 为 true 时要求界面取得覆盖确认后重试。 */
export interface export_result { exists: boolean; path: string }
/** @brief preload 唯一暴露给本地页面的能力集合。 */
export interface ai_code_bridge {
  /** @brief 请求主进程执行一项受限操作。
   * @param action 含判别字段 type 的操作参数。
   * @returns 主进程验证并执行后得到的结果。
   */
  invoke<t = unknown>(action: app_action): Promise<t>;
  /** @brief 订阅主进程事件。
   * @param callback 接收不含 Electron 事件对象的业务事件。
   * @returns 解除当前订阅的函数。
   */
  on_event(callback: (event: app_event) => void): () => void;
}
declare global { interface Window { ai_code: ai_code_bridge } }
