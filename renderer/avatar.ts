/** @file avatar.ts
 * @brief 保存按账号区分的本机头像，并在本地界面安全地显示图片。
 */
import type { app_state } from '../shared/types.js';
import { icon } from './icons.js';

const rendered_avatars = new WeakMap<HTMLElement, string>();
const storage_prefix = 'ai_code_avatar:';
let session_avatar = '';

/** @brief 使用账号邮箱作为本机头像归属；未登录的配置单独保存。
 * @param state 当前不含凭据的账号状态。
 * @returns 不随套餐变化的存储标识。
 */
export function avatar_owner(state: Pick<app_state, 'authenticated' | 'account_email'>): string {
  return state.authenticated ? (state.account_email ? `account:${state.account_email.trim().toLowerCase()}` : 'session') : 'guest';
}

/** @brief 退出或切换账号时清除无法按邮箱归属的临时头像。 */
export function clear_session_avatar(): void { session_avatar = ''; }

/** @brief 仅允许尺寸受限的主进程 PNG 结果作为头像来源。
 * @param value 待检查的数据地址。
 * @returns 是否是可直接交给本地图片元素的 PNG 数据地址。
 */
function valid_avatar(value: string): boolean {
  return value.length <= 100_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** @brief 读取当前账号的本机头像，忽略不可用或损坏的存储。
 * @param owner 头像所属账号标识。
 * @returns PNG 数据地址；未设置时为空字符串。
 */
export function read_avatar_preference(owner: string): string {
  if (owner === 'session') return session_avatar;
  try { const value = localStorage.getItem(storage_prefix + owner) || ''; return valid_avatar(value) ? value : ''; }
  catch { return ''; }
}

/** @brief 写入或移除当前账号的本机头像，不同步到远端。
 * @param owner 头像所属账号标识。
 * @param value 主进程验证的 PNG 数据地址；空字符串恢复默认头像。
 * @throws Error 图片来源不合法或本地存储不可用。
 */
export function write_avatar_preference(owner: string, value: string): void {
  if (value && !valid_avatar(value)) throw new Error('头像图片无效，请重新选择。');
  if (owner === 'session') { session_avatar = value; return; }
  try {
    if (value) localStorage.setItem(storage_prefix + owner, value);
    else localStorage.removeItem(storage_prefix + owner);
  } catch { throw new Error('无法保存本机头像，请检查本地存储空间。'); }
}

/** @brief 在圆形容器内显示头像，没有图片时使用统一的账号图标。
 * @param target 标题栏、侧栏或账号弹窗中的头像容器。
 * @param value 已验证的数据地址。
 */
export function render_avatar(target: HTMLElement, value: string): void {
  if (rendered_avatars.get(target) === value) return;
  rendered_avatars.set(target, value);
  if (!value) { target.innerHTML = icon('user'); return; }
  const picture = document.createElement('img'); picture.alt = ''; picture.draggable = false;
  picture.onerror = () => { if (target.contains(picture)) target.innerHTML = icon('user'); };
  picture.src = value; target.replaceChildren(picture);
}
