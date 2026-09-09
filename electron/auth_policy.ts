/**
 * @file auth_policy.ts
 * @brief 校验内置登录流程的官方入口、HTTPS 跳转和精确 loopback 回调。
 */

/** @brief 不含查询参数或凭据的导航判定，供登录窗口显示来源与错误。 */
export interface auth_decision { allowed: boolean; origin: string; error?: string }

/** @brief 绑定一次官方登录请求的导航策略。 */
export interface auth_policy {
  /** @brief 仅交给浏览器加载的官方登录地址，不发送到界面或日志。 */
  initial_url: string;
  /**
   * @brief 检查目标地址，非法地址以拒绝结果返回。
   * @param url 即将导航到的完整地址。
   * @returns 是否允许导航，以及可安全显示的 origin 或错误提示。
   */
  evaluate(url: string): auth_decision;
}

const official_hosts = new Set(['auth.openai.com', 'chatgpt.com', 'www.chatgpt.com', 'login.openai.com']);

/**
 * @brief 解析有长度限制且不携带 userinfo 的 URL。
 * @param value 待校验地址。
 * @returns 规范化 URL；格式、长度或字符不合法时返回 null。
 */
function parse(value: string): URL | null {
  if (!value || value.length > 32768 || /[\u0000-\u0020]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch { return null; }
}

/**
 * @brief 识别 localhost、IPv4/IPv6 回环地址及 IPv4 映射形式。
 * @param hostname URL 解析器提供的主机名。
 * @returns 主机是否属于回环地址。
 */
function loopback(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/u, '');
  return normalized === 'localhost' || normalized === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(normalized);
}

/**
 * @brief 从官方入口建立 HTTPS 身份提供方及精确 loopback 回调策略。
 * @param initial_url 官方登录流程返回的初始授权地址。
 * @returns 绑定原始 redirect_uri 和 state 的导航策略。
 * @throws Error 初始地址不属于允许的官方 HTTPS 入口或参数不唯一。
 */
export function create_auth_policy(initial_url: string): auth_policy {
  const initial = parse(initial_url);
  if (!initial || initial.protocol !== 'https:' || initial.port || !official_hosts.has(initial.hostname) ||
      initial.searchParams.getAll('redirect_uri').length > 1 || initial.searchParams.getAll('state').length > 1) {
    throw new Error('登录地址不是有效的官方 ChatGPT HTTPS 地址。');
  }
  let callback: URL | null = null;
  const redirect = initial.searchParams.get('redirect_uri');
  if (redirect) {
    const candidate = parse(redirect);
    if (candidate && (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
        loopback(candidate.hostname) && candidate.port && !candidate.hash) callback = candidate;
  }
  const expected_state = initial.searchParams.get('state');
  return {
    initial_url: initial.href,
    evaluate(value: string): auth_decision {
      const url = parse(value);
      const denied = { allowed: false, origin: '', error: '此跳转不属于允许的安全登录流程。' };
      if (!url) return denied;
      if (loopback(url.hostname) || url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname.endsWith('.localhost')) {
        if (!callback || url.protocol !== callback.protocol || url.host !== callback.host ||
            url.pathname !== callback.pathname || url.hash ||
            url.searchParams.getAll('state').length > 1 || url.searchParams.getAll('code').length > 1 ||
            (expected_state !== null && url.searchParams.get('state') !== expected_state)) return denied;
        for (const [name, expected] of callback.searchParams) {
          if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== expected) return denied;
        }
        return { allowed: true, origin: url.origin };
      }
      if (url.protocol !== 'https:') return denied;
      return { allowed: true, origin: url.origin };
    },
  };
}
