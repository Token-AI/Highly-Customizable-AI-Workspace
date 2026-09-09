/** @file avatar.test.ts
 * @brief 验证头像读取的显式路径、文件大小、链接、格式和裁剪边界。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { avatar_crop, inspect_avatar_image, max_avatar_bytes, read_avatar_file } from '../avatar';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** @brief 在测试专属目录创建有效小图片，仅读取明确选择的路径而不要求项目。 */
test('avatar reads explicit images without a project and rejects invalid paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-avatar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'avatar.PNG');
  await fs.writeFile(target, png);
  assert.deepEqual(await read_avatar_file(target), png);
  await assert.rejects(read_avatar_file(''), /本地图片路径/u);
  await assert.rejects(read_avatar_file('avatar.png'), /本地图片路径/u);
  await assert.rejects(read_avatar_file('https://example.org/avatar.png'), /本地图片路径/u);
  await fs.mkdir(path.join(root, 'directory.png'));
  await assert.rejects(read_avatar_file(path.join(root, 'directory.png')), /普通图片/u);
  await fs.writeFile(path.join(root, 'renamed.jpg'), png);
  await assert.rejects(read_avatar_file(path.join(root, 'renamed.jpg')), /扩展名/u);
  await assert.rejects(read_avatar_file(path.join(root, 'avatar.webp')), /仅支持 PNG 或 JPEG/u);
  await fs.writeFile(path.join(root, 'script.png'), '<svg onload="alert(1)"/>');
  await assert.rejects(read_avatar_file(path.join(root, 'script.png')), /有效的 PNG/u);
});

/** @brief 大于 5 MiB 的文件在分配读取缓冲前被拒绝，目录联接也不能绕过链接检查。 */
test('avatar rejects oversized files and directory links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-avatar-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, 'avatar.png'), png);
  await fs.symlink(actual, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(read_avatar_file(path.join(root, 'linked', 'avatar.png')), /链接|联接/u);
  const large = path.join(root, 'large.png');
  const handle = await fs.open(large, 'w');
  try { await handle.truncate(max_avatar_bytes + 1); } finally { await handle.close(); }
  await assert.rejects(read_avatar_file(large), /5 MiB/u);
  await fs.writeFile(path.join(root, 'empty.png'), Buffer.alloc(0));
  await assert.rejects(read_avatar_file(path.join(root, 'empty.png')), /5 MiB/u);
});

/** @brief 格式预检仅解析受支持容器，完整像素验证交由 Electron 原生解码。 */
test('avatar header inspection bounds PNG and JPEG dimensions', () => {
  assert.deepEqual(inspect_avatar_image(png), { format: 'png', width: 1, height: 1 });
  const large_png = Buffer.from(png); large_png.writeUInt32BE(100000, 16);
  assert.throws(() => inspect_avatar_image(large_png), /尺寸/u);
  assert.throws(() => inspect_avatar_image(png.subarray(0, 24)), /有效的 PNG/u);
  const jpeg_header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 40, 1, 1, 0x11, 0, 0xff, 0xd9]);
  assert.deepEqual(inspect_avatar_image(jpeg_header), { format: 'jpeg', width: 40, height: 20 });
  assert.throws(() => inspect_avatar_image(jpeg_header.subarray(0, 12)), /有效的 PNG/u);
  for (const bytes of [Buffer.alloc(0), Buffer.from('GIF89a'), Buffer.from('<svg/>'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])]) {
    assert.throws(() => inspect_avatar_image(bytes));
  }
});

/** @brief 横图和竖图始终从中心裁剪成方形，不接受非有限或零尺寸。 */
test('avatar crop centers portrait and landscape images', () => {
  assert.deepEqual(avatar_crop(401, 200), { x: 100, y: 0, width: 200, height: 200 });
  assert.deepEqual(avatar_crop(200, 401), { x: 0, y: 100, width: 200, height: 200 });
  assert.deepEqual(avatar_crop(128, 128), { x: 0, y: 0, width: 128, height: 128 });
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5, 100000]) {
    assert.throws(() => avatar_crop(size, 128));
  }
});
