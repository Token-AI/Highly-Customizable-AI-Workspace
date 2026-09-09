/**
 * @file format.ts
 * @brief 仅输出受控标记的消息格式化与路径显示工具。
 */

/** @brief 转义消息中的 HTML 特殊字符。
 * @param value 未受信任的消息文本。
 * @returns 可安全放入文本位置的 HTML 字符串。
 */
export function escape_html(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** @brief 在转义后解析行内代码和粗体，不加载远程资源。 */
function inline(value: string): string {
  /// 原始 HTML、链接和图片均作为文本处理。
  return value.split(/(`[^`\n]+`)/g).map(part => part.startsWith('`') && part.endsWith('`')
    ? `<code>${escape_html(part.slice(1, -1))}</code>`
    : escape_html(part).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')).join('');
}
/** @brief 渲染有限的 Markdown 子集，并容忍流式消息中未闭合的代码块。
 * @param value 助手返回的原始文本；最多处理一百万个字符。
 * @returns 只包含固定安全标签的 HTML。
 */
export function markdown(value: string): string {
  const lines = value.slice(0, 1_000_000).replace(/\r\n?/g, '\n').split('\n');
  let code: string[] | null = null; let paragraph: string[] = []; let list = false; const out: string[] = [];
  const flush = () => { if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const close_list = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flush(); close_list(); if (code) { out.push(`<pre><code>${escape_html(code.join('\n'))}</code></pre>`); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (heading) { flush(); close_list(); const n = Math.min(4, heading[1]!.length + 1); out.push(`<h${n}>${inline(heading[2]!)}</h${n}>`); }
    else if (bullet) { flush(); if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(bullet[1]!)}</li>`); }
    else if (!line.trim()) { flush(); close_list(); }
    else { close_list(); paragraph.push(line); }
  }
  flush(); close_list(); if (code) out.push(`<pre><code>${escape_html(code.join('\n'))}</code></pre>`);
  return out.join('');
}
/** @brief 获取适合界面显示的文件名，兼容两种路径分隔符。
 * @param path 待显示的完整路径。
 * @returns 路径的最后一个有效部分。
 */
export function basename(path: string): string { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
/** @brief 拼接文件选择器中的目录与已经验证的文件名。
 * @param path 当前目录的绝对路径。
 * @param name 不含路径分隔符的文件名。
 * @returns 交给主进程再次验证的完整路径。
 */
export function join_path(path: string, name: string): string { return path.replace(/[\\/]+$/, '') + (path.includes('\\') ? '\\' : '/') + name; }
