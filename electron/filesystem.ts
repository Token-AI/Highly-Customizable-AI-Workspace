/**
 * @file filesystem.ts
 * @brief 提供有项目边界的文本预览、目录浏览和显式确认的会话导出。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { chat_message, directory_listing, export_result, file_preview } from '../shared/types';

/** @brief 单个预览最多读取的字节数。 */
export const max_preview_bytes = 256 * 1024;
const max_entries = 5000;

/**
 * @brief 校验并规范化调用方提供的绝对路径。
 * @param value 原始路径。
 * @returns 规范化绝对路径。
 * @throws Error 路径类型、长度、NUL 字符或绝对路径形式不合法。
 */
function absolute(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('请输入有效的绝对路径。');
  }
  return path.resolve(value);
}

/**
 * @brief 按路径段判断词法包含关系，避免相似目录前缀越界。
 * @param root 允许的根目录。
 * @param target 待检查的规范化绝对路径。
 * @returns 目标是否为根目录自身或其后代。
 */
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * @brief 逐段拒绝符号链接和 Windows 目录联接。
 * @param target 待检查的完整路径。
 * @param from 已验证的起始目录，默认从盘符或文件系统根开始。
 * @returns 路径各段检查完成后的 Promise。
 * @throws Error 任一段为链接，或底层文件系统无法访问路径。
 */
async function no_links(target: string, from = path.parse(target).root): Promise<void> {
  const relative = path.relative(from, target);
  let current = from;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const information = await fs.lstat(current);
    if (information.isSymbolicLink()) throw new Error('不跟随符号链接或目录联接，请选择实际路径。');
  }
}

/**
 * @brief 严格解码 UTF-8 或带 BOM 的 UTF-16，并拒绝二进制控制字符。
 * @param buffer 已读取的预览字节。
 * @param truncated 是否因预览上限截断，允许忽略末尾不完整编码序列。
 * @returns 可显示的文本，不修改文件内容。
 * @throws Error 字节编码无效或内容包含二进制控制字符。
 */
export function decode_preview(buffer: Buffer, truncated: boolean): string {
  let encoding = 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
  let content: string;
  try { content = new TextDecoder(encoding, { fatal: true }).decode(buffer, { stream: truncated }); }
  catch { throw new Error('此文件不是有效的 UTF-8 或带 BOM 的 UTF-16 文本，无法预览。'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/u.test(content)) throw new Error('此文件包含二进制数据，无法预览。');
  return content;
}

/** @brief 管理当前项目读取边界及用户明确选择的导出目标。 */
export class file_system_service {
  private project_roots: string[];
  /**
   * @brief 保存可选项目路径；空路径表示尚未打开项目。
   * @param root 初始绝对路径或空字符串，磁盘验证由 set_root 完成。
   * @throws Error 路径格式不合法。
   */
  constructor(root = '') { this.project_roots = root === '' ? [] : [absolute(root)]; }

  /**
   * @brief 读取当前项目根目录。
   * @returns 当前保存的绝对路径；未打开项目时为空字符串。
   */
  get root(): string { return this.project_roots[0] ?? ''; }

  /** @brief 返回当前独立目录边界的副本，调用方不能修改内部配置。 */
  get roots(): string[] { return [...this.project_roots]; }

  /**
   * @brief 验证实际目录与各级链接状态后切换项目根。
   * @param value 用户选择的项目绝对路径。
   * @returns 经 realpath 规范化的实际目录。
   * @throws Error 路径无效、为链接、不是目录或无法访问。
   */
  async set_root(value: string): Promise<string> {
    await this.set_roots([absolute(value)]);
    return this.root;
  }

  /**
   * @brief 全部目录验证成功后一次替换项目边界；空数组退出文件工作区。
   * @param values 最多十六个绝对目录，可位于不同盘符。
   * @returns 去重并规范化的独立根目录列表，保留用户顺序。
   * @throws Error 任一目录无效或包含链接；失败时原边界保持不变。
   */
  async set_roots(values: string[]): Promise<string[]> {
    if (!Array.isArray(values) || values.length > 16) throw new Error('每个项目最多包含 16 个目录。');
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const selected = absolute(value);
      await no_links(selected);
      if (!(await fs.stat(selected)).isDirectory()) throw new Error('项目路径必须是文件夹。');
      const canonical = await fs.realpath(selected);
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (!seen.has(key)) { seen.add(key); roots.push(canonical); }
    }
    this.project_roots = roots;
    return this.roots;
  }

  /**
   * @brief 同时检查词法边界、链接状态和实际路径归属。
   * @param value 项目内目标的绝对路径。
   * @returns 验证后的实际路径。
   * @throws Error 目标越出项目、包含链接或无法访问。
   */
  private async project_path(value: string): Promise<string> {
    if (!this.project_roots.length) throw new Error('尚未打开项目目录，请先选择包含目录的项目。');
    const selected = absolute(value);
    const root = this.project_roots.find(candidate => contained(candidate, selected));
    if (!root) throw new Error('只允许读取当前项目目录中的文件。');
    /// 每次读取重新检查根目录的祖先，防止选中之后将根目录替换成联接。
    await no_links(selected);
    const canonical = await fs.realpath(selected);
    if (!contained(root, canonical)) throw new Error('文件路径超出了当前项目目录。');
    return canonical;
  }

  /**
   * @brief 仅枚举目录元数据，跳过链接并限制返回条目数量。
   * @param value 待枚举目录的绝对路径；非项目模式的空路径表示磁盘入口。
   * @param project_only true 限制在当前项目；false 用于任意目录选择器。
   * @returns 排序后的目录条目、父路径及截断标志。
   * @throws Error 路径或项目边界验证失败，或目录无法访问。
   */
  async list_directory(value: string, project_only = false): Promise<directory_listing> {
    if (value === '' && !project_only) return this.list_roots();
    const selected = project_only ? await this.project_path(value) : absolute(value);
    if (!project_only) await no_links(selected);
    const entries: directory_listing['entries'] = [];
    let truncated = false;
    const directory = await fs.opendir(selected);
    for await (const entry of directory) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      if (entries.length >= max_entries) { truncated = true; break; }
      entries.push({ name: entry.name, path: path.join(selected, entry.name), directory: entry.isDirectory() });
    }
    entries.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
    const parent = project_only && this.project_roots.includes(selected) ? selected
      : !project_only && selected === path.parse(selected).root ? '' : path.dirname(selected);
    return { path: selected, parent, entries, truncated };
  }

  /**
   * @brief 仅探测可浏览的文件系统根，不自动选择项目或枚举根目录内容。
   * @returns Windows 可读盘符或其他系统的根目录，虚拟入口自身的路径为空。
   */
  private async list_roots(): Promise<directory_listing> {
    const candidates = process.platform === 'win32'
      ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
      : ['/'];
    const roots = await Promise.all(candidates.map(async candidate => {
      try {
        const directory = await fs.opendir(candidate);
        await directory.close();
        return { name: candidate, path: candidate, directory: true };
      } catch { return null; }
    }));
    const entries = roots.filter((entry): entry is directory_listing['entries'][number] => entry !== null);
    return { path: '', parent: '', entries, truncated: false };
  }

  /**
   * @brief 在项目边界内读取至多 256 KiB 的普通文本文件。
   * @param value 用户要求预览或附加的绝对文件路径。
   * @returns 实际路径、解码文本和截断标志。
   * @throws Error 路径越界、文件变化、非普通文件、编码无效或读取失败。
   */
  async read_file(value: string): Promise<file_preview> {
    const selected = await this.project_path(value);
    const file = await fs.open(selected, 'r');
    try {
      const information = await file.stat();
      if (!information.isFile()) throw new Error('只能预览普通文件。');
      /// 打开句柄后、读取内容前再次检查路径归属与文件标识。
      const canonical = await this.project_path(value);
      const current = await fs.lstat(canonical);
      if (current.dev !== information.dev || current.ino !== information.ino) throw new Error('文件在打开期间发生变化，请重试。');
      const length = Math.min(information.size, max_preview_bytes);
      const buffer = Buffer.alloc(length);
      let count = 0;
      while (count < length) {
        const read = await file.read(buffer, count, length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      const truncated = information.size > max_preview_bytes;
      return { path: canonical, content: decode_preview(buffer.subarray(0, count), truncated), truncated };
    } finally { await file.close(); }
  }

  /**
   * @brief 将后端会话导出为 Markdown，已有文件需明确允许覆盖。
   * @param value 用户选择的绝对目标路径，可位于项目之外。
   * @param overwrite 用户是否已确认替换已有普通文件。
   * @param messages 主进程提供的后端消息，不接受渲染页面自报的内容。
   * @returns 目标路径；exists 为 true 表示仍需用户确认且尚未覆盖。
   * @throws Error 目标为链接或非普通文件、路径无效，或写入失败。
   */
  async export_conversation(value: string, overwrite: boolean, messages: readonly chat_message[]): Promise<export_result> {
    const selected = absolute(value);
    await no_links(path.dirname(selected));
    try {
      const information = await fs.lstat(selected);
      if (information.isSymbolicLink() || !information.isFile()) throw new Error('导出目标必须是普通文件。');
      if (!overwrite) return { exists: true, path: selected };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const labels = { user: '用户', assistant: '助手', tool: '工具', system: '系统' } as const;
    const document = '# AI Code 对话\n\n' + messages.map(message => `## ${labels[message.role]}\n\n${message.text}\n`).join('\n');
    if (!overwrite) {
      try { await fs.writeFile(selected, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { exists: true, path: selected };
        throw error;
      }
    } else {
      const temporary = path.join(path.dirname(selected), `.ai-code-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, selected);
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    }
    return { exists: false, path: selected };
  }
}
