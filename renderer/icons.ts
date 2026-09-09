/** @file icons.ts
 * @brief 自绘 16 像素单色轮廓图标，供工作台和登录窗口共用。
 * @details 直线以半像素坐标对齐 1px 描边；不依赖图标库或远程资源。
 */

/** @brief 固定图形白名单；保留现有调用名称，所有图形均使用无填充轮廓。 */
const icon_paths: Readonly<Record<string, string>> = Object.freeze({
  folder: '<path d="M1.5 3.5h4l2 2h7v8h-13zM1.5 5.5h6"/>',
  'folder-plus': '<path d="M8.5 13.5h-7v-10h4l2 2h7v3M1.5 5.5h6M12.5 10v5M10 12.5h5"/>',
  file: '<path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3"/>',
  minus: '<path d="M3.5 7.5h9"/>',
  square: '<rect x="3.5" y="3.5" width="9" height="9"/>',
  restore: '<path d="M6.5 4.5v-2h7v7h-2"/><rect x="2.5" y="5.5" width="8" height="8"/>',
  close: '<path d="m3.5 3.5 9 9m-9 0 9-9"/>',
  plus: '<path d="M7.5 2.5v11M2.5 7.5h11"/>',
  search: '<circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/>',
  steer: '<path d="M13.5 2.5v6h-10m4-4-4 4 4 4"/>',
  chevron: '<path d="m5.5 3.5 4.5 4.5-4.5 4.5"/>',
  'chevron-down': '<path d="m3.5 5.5 4.5 4.5 4.5-4.5"/>',
  refresh: '<path d="M13.5 5.5A5.5 5.5 0 1 0 13.2 11M13.5 1.5v4h-4"/>',
  user: '<circle cx="8" cy="8" r="6.5"/><circle cx="8" cy="5.5" r="2"/><path d="M3.5 12.5c.5-2 2-3 4.5-3s4 1 4.5 3"/>',
  login: '<path d="M9.5 1.5h4v13h-4M1.5 8.5h8m-3-3 3 3-3 3"/>',
  'arrow-right': '<path d="M2.5 7.5h11m-4-4 4 4-4 4"/>',
  'arrow-up': '<path d="M7.5 13.5v-11m-4 4 4-4 4 4"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M7.5 4v1M6.5 7.5h1v4h1.5"/>',
  spark: '<path d="m6.5 3.5 1.5 3.5 3.5 1.5L8 10l-1.5 3.5L5 10 1.5 8.5 5 7zM12.5 1.5v4m-2-2h4"/>',
  copy: '<path d="M5.5 4.5v-3h8v10h-3"/><rect x="2.5" y="4.5" width="8" height="10"/>',
  export: '<path d="M7.5 10.5v-9m-3 3 3-3 3 3M2.5 9.5v4h11v-4"/>',
  code: '<path d="M5 4.5 1.5 8 5 11.5M11 4.5 14.5 8 11 11.5M9.5 2.5l-3 11"/>',
  shield: '<path d="m8 1.5 5.5 2V8c0 3-3.5 5.5-5.5 6.5C6 13.5 2.5 11 2.5 8V3.5zM5 7.5l2 2 4-4"/>',
  chat: '<path d="M1.5 2.5h13v9h-9l-4 3zM4.5 5.5h7m-7 3h5"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7"/>',
  check: '<path d="m2.5 8.5 4 4 7-9"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11"/><path d="m4 5.5 2.5 2.5L4 10.5m4.5 0h3"/>',
});

/** @brief 从固定白名单创建继承文字颜色的 16×16 图标。
 * @param name 图标名称；未知名称和原型属性名均回退到文件图标。
 * @returns 无可聚焦元素、不包含调用者输入内容的 SVG 标记。
 */
export function icon(name: string): string {
  const geometry = Object.hasOwn(icon_paths, name) ? icon_paths[name] : icon_paths.file;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true" focusable="false">${geometry}</svg>`;
}

/** @brief 填充页面中声明了 data-icon 的图标占位元素。
 * @param root 需要初始化图标的 DOM 子树。
 * @returns 完成当前子树的同步图标填充，无返回值。
 */
export function mount_icons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach(element => {
    element.innerHTML = icon(element.dataset.icon ?? 'file');
  });
}
