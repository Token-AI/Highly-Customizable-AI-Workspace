/**
 * @file auth_theme.ts
 * @brief 为官方登录页面提供外观覆盖，不读取表单数据或改变认证逻辑。
 */

/** @brief 判断当前顶层页面是否允许应用本地登录主题。
 * @param value 顶层页面 URL，仅用于验证协议和精确域名。
 * @returns 仅 OpenAI 官方 HTTPS 登录来源返回 true。
 * @note 第三方身份提供方和本地 OAuth 回调不注入样式。
 */
export function supports_auth_theme(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      ['auth.openai.com', 'login.openai.com', 'chatgpt.com', 'www.chatgpt.com'].includes(url.hostname);
  } catch { return false; }
}

/** @brief 采用紧凑的编辑器登录窗口外观，保留官方内容及表单行为。 */
export const auth_theme_css = `
:root { color-scheme: light !important; }
body {
  font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif !important;
  color: #34363b !important;
  background-color: #ffffff !important;
}
h1 {
  font-size: 24px !important;
  font-weight: 400 !important;
  line-height: 1.4 !important;
  color: #686e79 !important;
}
main { padding-block: 12px !important; }
input, button, select, textarea {
  font-family: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif !important;
  font-size: 14px !important;
}
form :is(label, div, fieldset):has(> input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])) {
  border-radius: 4px !important;
}
input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea {
  border-radius: 4px !important;
  background-color: #ffffff !important;
  color: #34363b !important;
}
input:not([aria-invalid="true"]):not(:invalid):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]) {
  border-color: #a0a5ad !important;
}
input:focus-visible, button:focus-visible, select:focus-visible, a:focus-visible {
  outline: 2px solid #007acc !important;
  outline-offset: 0 !important;
}
form :is(label, div, fieldset):has(> input:not([type="hidden"]):focus-visible) {
  border-color: #007acc !important;
  box-shadow: 0 0 0 1px #007acc !important;
}
form :is(label, div, fieldset) > input:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}
button, input[type="submit"], a[role="button"] {
  border-radius: 4px !important;
}
button[type="submit"]:not(:disabled), input[type="submit"]:not(:disabled) {
  background-color: #007acc !important;
  border-color: #007acc !important;
  color: #ffffff !important;
}
button[type="submit"]:not(:disabled):hover, input[type="submit"]:not(:disabled):hover {
  background-color: #006bb3 !important;
}
`;
