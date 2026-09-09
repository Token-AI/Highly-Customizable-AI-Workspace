/** @file projects.ts
 * @brief 原子保存项目定义和有界会话归属，不持久保存当前项目选择。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { project_info } from '../shared/types';

const max_projects = 100;
const max_thread_mappings = 1000;
const max_storage_bytes = 4 * 1024 * 1024;
const uuid_pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** @brief 按当前系统路径规则生成比较键，不访问目录。 */
function path_key(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }

/**
 * @brief 规范化项目目录定义，仅读取字符串而不探测目录是否可用。
 * @param values 最多十六个绝对路径。
 * @returns 保留顺序且去重的目录定义。
 * @throws Error 路径格式、数量或长度不合法。
 */
export function project_directories(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 16) throw new Error('每个项目最多包含 16 个目录。');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value)) {
      throw new Error('项目目录必须是有效的绝对路径。');
    }
    const directory = path.resolve(value);
    const key = path_key(directory);
    if (!seen.has(key)) { seen.add(key); result.push(directory); }
  }
  return result;
}

/** @brief 验证项目名称和 UUID，目录可用性由显式选择流程检查。 */
function definition(value: unknown): project_info {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目定义无效。');
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !uuid_pattern.test(entry.id)) throw new Error('项目编号无效。');
  if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 80 || /[\u0000-\u001f]/u.test(entry.name)) {
    throw new Error('项目名称须为 1 至 80 个字符。');
  }
  return { id: entry.id, name: entry.name.trim(), directories: project_directories(entry.directories) };
}

/** @brief 项目配置存储；所有磁盘写入串行执行，目录选择与账号状态不进入文件。 */
export class project_store {
  private readonly filename: string;
  private entries: project_info[] = [];
  private threads = new Map<string, string>();
  private mapping_version = 0;
  private saved_mapping_version = 0;
  private source: string | null = null;
  private loaded = false;
  private blocked = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** @param filename 独立 userData/projects.json 的绝对路径。 */
  constructor(filename: string) { this.filename = path.resolve(filename); }

  /** @brief 返回可安全发送到界面的项目定义副本。 */
  get catalog(): project_info[] { return this.entries.map(entry => ({ ...entry, directories: [...entry.directories] })); }
  /** @brief 配置是否已加载且允许显式保存。 */
  get writable(): boolean { return this.loaded && !this.blocked; }

  /** @brief 读取指定项目的副本，不检查它的目录是否存在。 */
  find(id: string): project_info | undefined { return this.catalog.find(entry => entry.id === id); }

  /** @brief 查找与单目录兼容入口对应的已保存项目。 */
  match_directory(directory: string): project_info | undefined {
    const key = path_key(path.resolve(directory));
    return this.catalog.find(entry => entry.directories.length === 1 && path_key(entry.directories[0]) === key);
  }

  /** @brief 获取会话映射到的项目；不存在或已删除时返回 undefined。 */
  for_thread(id: string): project_info | undefined { const project_id = this.threads.get(id); return project_id ? this.find(project_id) : undefined; }

  /** @brief 读取有大小限制的普通配置文件，拒绝符号链接和目录。 */
  private async read_source(): Promise<string | null> {
    try {
      const information = await fs.lstat(this.filename);
      if (!information.isFile() || information.isSymbolicLink() || information.size > max_storage_bytes) throw new Error('项目配置文件类型或大小无效。');
      const content = await fs.readFile(this.filename, 'utf8');
      if (Buffer.byteLength(content) > max_storage_bytes) throw new Error('项目配置文件过大。');
      return content;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  /**
   * @brief 加载目录定义和会话映射，不恢复当前选择，也不访问项目目录。
   * @throws Error 配置损坏或不可读；该实例随后禁止覆盖原文件。
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const source = await this.read_source();
      if (source === null) { this.source = null; return; }
      const data = JSON.parse(source) as Record<string, unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
          !Array.isArray(data.projects) || data.projects.length > max_projects || !Array.isArray(data.thread_projects) ||
          data.thread_projects.length > max_thread_mappings) throw new Error('项目配置格式无效。');
      const entries = data.projects.map(definition);
      const ids = new Set(entries.map(entry => entry.id));
      if (ids.size !== entries.length) throw new Error('项目配置包含重复编号。');
      const threads = new Map<string, string>();
      for (const item of data.thread_projects) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !/^[\w-]{1,200}$/u.test(item[0]) ||
            typeof item[1] !== 'string' || !ids.has(item[1]) || threads.has(item[0])) throw new Error('会话项目映射无效。');
        threads.set(item[0], item[1]);
      }
      this.entries = entries; this.threads = threads; this.source = source;
    } catch {
      this.blocked = true;
      throw new Error(`项目配置无法读取或已损坏，原文件未修改。请检查 ${this.filename} 后重启客户端。`);
    }
  }

  /** @brief 拒绝覆盖损坏配置，或在读取完成前进行写入。 */
  private assert_writable(): void {
    if (!this.loaded || this.blocked) throw new Error('项目配置当前不可写，请修复配置后重启客户端；原文件未修改。');
  }

  /** @brief 串行安排文件事务，单次失败不会阻塞后续显式重试。 */
  private enqueue<result_type>(operation: () => Promise<result_type>): Promise<result_type> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** @brief 同目录临时文件写入并同步后原子替换，同时检测外部配置修改。 */
  private async write(entries: project_info[], threads: Map<string, string>): Promise<void> {
    this.assert_writable();
    const serialized = JSON.stringify({ version: 1, projects: entries, thread_projects: [...threads] }, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > max_storage_bytes) throw new Error('项目配置超过 4 MiB，请减少目录定义。');
    if (await this.read_source() !== this.source) {
      this.blocked = true;
      throw new Error('项目配置已被其他程序更改，请重启后再操作，现有文件未覆盖。');
    }
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = path.join(path.dirname(this.filename), `.projects-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filename);
      this.source = serialized;
    } finally { if (created) await fs.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }

  /**
   * @brief 创建或编辑项目定义；磁盘提交成功后才更新内存目录。
   * @param id 已有 UUID，undefined 表示新建。
   * @param name 显示名称。
   * @param directories 已由显式项目操作验证的目录列表，也可为空。
   * @returns 提交后的项目副本。
   * @throws Error 定义无效、超出数量限制、编号不存在或原子写入失败。
   */
  async save_project(id: string | undefined, name: string, directories: string[]): Promise<project_info> {
    return this.enqueue(async () => {
      this.assert_writable();
      const entry = definition({ id: id ?? randomUUID(), name, directories });
      const index = this.entries.findIndex(project => project.id === entry.id);
      if (id !== undefined && index < 0) throw new Error('要编辑的项目不存在。');
      if (index < 0 && this.entries.length >= max_projects) throw new Error('最多保存 100 个项目。');
      const entries = this.catalog;
      if (index < 0) entries.push(entry); else entries[index] = entry;
      const version = this.mapping_version;
      await this.write(entries, new Map(this.threads));
      this.entries = entries; this.saved_mapping_version = version;
      return { ...entry, directories: [...entry.directories] };
    });
  }

  /** @brief 仅删除项目定义及其会话映射，不删除目录或会话文件。 */
  async delete_project(id: string): Promise<void> {
    await this.enqueue(async () => {
      this.assert_writable();
      if (!this.entries.some(entry => entry.id === id)) throw new Error('要删除的项目不存在。');
      const entries = this.catalog.filter(entry => entry.id !== id);
      const threads = new Map([...this.threads].filter(([, project]) => project !== id));
      const version = this.mapping_version;
      await this.write(entries, threads);
      this.entries = entries;
      for (const [thread, project] of this.threads) if (project === id) this.threads.delete(thread);
      this.saved_mapping_version = version;
    });
  }

  /**
   * @brief 记录新会话归属；同一映射不会造成重复磁盘写入。
   * @returns 映射是否发生改变，调用方可据此合并后续 flush。
   */
  remember_thread(thread: string, project: string): boolean {
    if (!this.loaded || this.blocked || !/^[\w-]{1,200}$/u.test(thread) || !this.entries.some(entry => entry.id === project) || this.threads.get(thread) === project) return false;
    this.threads.delete(thread); this.threads.set(thread, project);
    while (this.threads.size > max_thread_mappings) this.threads.delete(this.threads.keys().next().value!);
    ++this.mapping_version;
    return true;
  }

  /** @brief 合并保存待写会话映射；期间出现新映射时再提交一次，不写当前选择。 */
  async flush(): Promise<void> {
    await this.enqueue(async () => {
      while (this.mapping_version !== this.saved_mapping_version) {
        const version = this.mapping_version;
        await this.write(this.catalog, new Map(this.threads));
        this.saved_mapping_version = version;
      }
    });
  }
}
