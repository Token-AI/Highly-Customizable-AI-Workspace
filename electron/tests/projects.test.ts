/** @file projects.test.ts
 * @brief 验证项目配置持久化、损坏保护和有界会话归属，不访问实际用户目录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { project_directories, project_store } from '../projects';

/** @brief 项目可包含多个或零个目录，重启只恢复定义，不恢复选择。 */
test('projects persist definitions without selecting or probing their directories', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-projects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'projects.json');
  const store = new project_store(filename); await store.load();
  const missing = path.join(root, 'disconnected-drive-project');
  const entry = await store.save_project(undefined, '  Example  ', [missing, path.join(root, 'second')]);
  assert.equal(entry.name, 'Example'); assert.match(entry.id, /^[\da-f-]{36}$/u);
  const empty = await store.save_project(undefined, 'Empty', []);
  const copy = store.catalog; copy[0].directories.push(root); copy[0].name = 'Changed';
  assert.equal(store.find(entry.id)?.directories.length, 2);
  assert.equal(store.find(entry.id)?.name, 'Example');
  const loaded = new project_store(filename); await loaded.load();
  assert.deepEqual(loaded.catalog, store.catalog);
  assert.deepEqual(loaded.find(empty.id)?.directories, []);
  const data = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ['projects', 'thread_projects', 'version']);
  assert.equal(await fs.stat(missing).then(() => true, () => false), false);
});

/** @brief 编辑保留项目编号，删除仅修改配置及归属，原目录和文件仍保留。 */
test('editing and deleting projects never delete workspace content', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-project-delete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'keep.txt'); await fs.writeFile(marker, 'keep');
  const filename = path.join(root, 'projects.json');
  const store = new project_store(filename); await store.load();
  const entry = await store.save_project(undefined, 'Before', [root]);
  const changed = await store.save_project(entry.id, 'After', [root]);
  assert.equal(changed.id, entry.id); assert.equal(store.match_directory(root)?.name, 'After');
  assert.equal(store.remember_thread('thread-a', entry.id), true);
  assert.equal(store.remember_thread('thread-a', entry.id), false);
  await store.flush();
  const reopened = new project_store(filename); await reopened.load();
  assert.equal(reopened.for_thread('thread-a')?.id, entry.id);
  await reopened.delete_project(entry.id);
  assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
  assert.equal(reopened.for_thread('thread-a'), undefined);
  assert.deepEqual(reopened.catalog, []);
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});

/** @brief 损坏配置和外部修改均不能被下一次保存静默覆盖。 */
test('corrupt or externally edited project files stay intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-project-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'projects.json');
  await fs.writeFile(filename, '{broken');
  const damaged = new project_store(filename);
  await assert.rejects(damaged.load(), /损坏/u);
  await assert.rejects(damaged.save_project(undefined, 'No overwrite', []), /不可写/u);
  assert.equal(await fs.readFile(filename, 'utf8'), '{broken');
  await fs.writeFile(filename, JSON.stringify({ version: 1, projects: [], thread_projects: [] }));
  const changed = new project_store(filename); await changed.load();
  const replacement = '{"version":1,"projects":[],"thread_projects":[],"external":true}';
  await fs.writeFile(filename, replacement);
  await assert.rejects(changed.save_project(undefined, 'No overwrite', []), /其他程序/u);
  assert.equal(await fs.readFile(filename, 'utf8'), replacement);
  assert.deepEqual(changed.catalog, []);
});

/** @brief 会话归属有界，重复状态不会再次加入映射，重载后保留最近条目。 */
test('thread project mappings are bounded and stable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-project-map-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'projects.json');
  const store = new project_store(filename); await store.load();
  const entry = await store.save_project(undefined, 'Mapped', []);
  for (let index = 0; index < 1005; ++index) store.remember_thread(`thread-${index}`, entry.id);
  await store.flush();
  const saved = await fs.readFile(filename, 'utf8');
  assert.equal((JSON.parse(saved) as { thread_projects: unknown[] }).thread_projects.length, 1000);
  assert.equal(store.remember_thread('thread-1004', entry.id), false);
  await store.flush(); assert.equal(await fs.readFile(filename, 'utf8'), saved);
  const reopened = new project_store(filename); await reopened.load();
  assert.equal(reopened.for_thread('thread-0'), undefined);
  assert.equal(reopened.for_thread('thread-1004')?.id, entry.id);
});

/** @brief 拒绝过多项目、空名称和越界目录定义；项目目录去重后仍保持原顺序。 */
test('project limits and identifiers are validated', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-project-limits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'projects.json');
  const entries = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), name: `Project ${index}`, directories: [] }));
  await fs.writeFile(filename, JSON.stringify({ version: 1, projects: entries, thread_projects: [] }));
  const store = new project_store(filename); await store.load();
  await assert.rejects(store.save_project(undefined, 'Too many', []), /100/u);
  await assert.rejects(store.save_project(entries[0].id, '', []), /名称/u);
  await assert.rejects(store.save_project(entries[0].id, 'x'.repeat(81), []), /名称/u);
  await assert.rejects(store.save_project('not-a-uuid', 'Bad id', []), /编号/u);
  assert.throws(() => project_directories(['relative']), /绝对路径/u);
  assert.throws(() => project_directories(Array(17).fill(root)), /16/u);
  assert.deepEqual(project_directories([root, root, path.join(root, 'child')]), [root, path.join(root, 'child')]);
});
