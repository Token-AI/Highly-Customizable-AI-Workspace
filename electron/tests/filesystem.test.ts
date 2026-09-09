/**
 * @file filesystem.test.ts
 * @brief 验证项目路径隔离、文本预览上限及导出覆盖确认。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file_system_service, max_preview_bytes, decode_preview } from '../filesystem';

/** @brief 多目录分别授权，不能借共同父目录扩大读取范围，失败的切换保留原边界。 */
test('multiple roots remain separate and update only after complete validation', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-roots-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const first = path.join(temporary, 'first'); const second = path.join(temporary, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'one.txt'), 'one');
  await fs.writeFile(path.join(second, 'two.txt'), 'two');
  await fs.writeFile(path.join(temporary, 'outside.txt'), 'outside');
  const files = new file_system_service();
  await files.set_roots([first, second, first]);
  assert.equal(files.root, await fs.realpath(first)); assert.equal(files.roots.length, 2);
  assert.equal((await files.read_file(path.join(first, 'one.txt'))).content, 'one');
  assert.equal((await files.read_file(path.join(second, 'two.txt'))).content, 'two');
  assert.equal((await files.list_directory(second, true)).parent, await fs.realpath(second));
  await assert.rejects(files.read_file(path.join(temporary, 'outside.txt')), /当前项目/u);
  await assert.rejects(files.list_directory(temporary, true), /当前项目/u);
  await assert.rejects(files.set_roots([first, path.join(temporary, 'missing')]));
  assert.equal((await files.read_file(path.join(second, 'two.txt'))).content, 'two');
  const copy = files.roots; copy.push(temporary);
  await assert.rejects(files.read_file(path.join(temporary, 'outside.txt')), /当前项目/u);
  await files.set_roots([]); assert.equal(files.root, '');
  await assert.rejects(files.read_file(path.join(first, 'one.txt')), /尚未打开项目/u);
});

/** @brief 根目录选定后被替换为联接时，也必须阻止后续读取。 */
test('replacing a selected root with a link does not expand access', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-root-link-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'root'); const outside = path.join(temporary, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  const files = new file_system_service(); await files.set_roots([root]);
  await fs.rename(root, path.join(temporary, 'original-root'));
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.read_file(path.join(root, 'secret.txt')), /链接|联接/u);
});

/** @brief 未打开项目时只允许显式目录浏览，磁盘入口不隐式选择当前工作目录。 */
test('empty workspace exposes drive roots and rejects project operations', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-empty-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const files = new file_system_service();
  assert.equal(files.root, '');
  const listing = await files.list_directory('');
  assert.equal(listing.path, '');
  assert.equal(listing.parent, '');
  assert.equal(listing.truncated, false);
  assert.ok(listing.entries.length > 0);
  assert.ok(listing.entries.every(entry => entry.directory && entry.path === path.parse(entry.path).root));
  assert.ok(listing.entries.some(entry => entry.path.toLowerCase() === path.parse(temporary).root.toLowerCase()));
  const root_listing = await files.list_directory(path.parse(temporary).root);
  assert.equal(root_listing.parent, '');
  await assert.rejects(files.list_directory(temporary, true), /尚未打开项目/u);
  await assert.rejects(files.read_file(path.join(temporary, 'test.txt')), /尚未打开项目/u);
  await assert.rejects(files.set_root(''), /绝对路径/u);
  await assert.rejects(files.export_conversation('', false, []), /绝对路径/u);
  assert.equal((await files.list_directory(temporary)).path, temporary);
  assert.equal(files.root, '');
  await files.set_root(temporary);
  assert.equal((await files.list_directory(temporary, true)).path, await fs.realpath(temporary));
});

/** @brief 项目读取不能越界或跟随联接，而目录选择器可浏览明确指定的其他目录。 */
test('project reads reject traversal and directory junctions', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-files-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'project');
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'main.cpp'), 'int main() {}');
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
  const files = new file_system_service(root); await files.set_root(root);
  assert.equal((await files.read_file(path.join(root, 'main.cpp'))).content, 'int main() {}');
  await assert.rejects(files.read_file(path.join(outside, 'private.txt')));
  await assert.rejects(files.list_directory(outside, true));
  assert.equal((await files.list_directory(outside)).entries[0].name, 'private.txt');
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(files.read_file(path.join(root, 'linked', 'private.txt')));
  assert.equal((await files.list_directory(root, true)).entries.some(entry => entry.name === 'linked'), false);
});

/** @brief 预览限制读取大小并严格区分支持的文本编码与二进制内容。 */
test('preview validates encoding and bounds large files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new file_system_service(root); await files.set_root(root);
  await fs.writeFile(path.join(root, 'large.txt'), 'a'.repeat(max_preview_bytes + 100));
  const preview = await files.read_file(path.join(root, 'large.txt'));
  assert.equal(preview.content.length, max_preview_bytes); assert.equal(preview.truncated, true);
  assert.equal(decode_preview(Buffer.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]), false), '你好');
  assert.equal(decode_preview(Buffer.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d]), false), '你好');
  assert.throws(() => decode_preview(Buffer.from([0xff, 0x80]), false));
  assert.throws(() => decode_preview(Buffer.from([0, 1, 2]), false));
  assert.equal(decode_preview(Buffer.from([0x61, 0xe4, 0xbd]), true), 'a');
});

/** @brief 未确认覆盖时保留原文件，确认后仅写入主进程提供的消息。 */
test('export requires explicit overwrite and writes only supplied backend messages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new file_system_service(root); await files.set_root(root);
  const target = path.join(root, 'chat.md');
  const messages = [{ id: '1', role: 'user' as const, text: 'hello' }];
  assert.equal((await files.export_conversation(target, false, messages)).exists, false);
  assert.equal((await files.export_conversation(target, false, [])).exists, true);
  assert.match(await fs.readFile(target, 'utf8'), /hello/u);
  assert.equal((await files.export_conversation(target, true, [])).exists, false);
  assert.doesNotMatch(await fs.readFile(target, 'utf8'), /hello/u);
});
