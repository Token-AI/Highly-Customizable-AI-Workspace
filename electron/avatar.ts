/** @file avatar.ts
 * @brief 读取用户明确选择的本地头像，并在原生解码前限制文件和图像尺寸。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** @brief 原始头像文件的最大字节数。 */
export const max_avatar_bytes = 5 * 1024 * 1024;
const max_avatar_dimension = 16384;
const max_avatar_pixels = 32 * 1024 * 1024;

/** @brief 仅从容器头取得的图像信息；完整格式验证仍由 Electron 解码器负责。 */
export interface avatar_metadata { format: 'png' | 'jpeg'; width: number; height: number }

/**
 * @brief 拒绝零尺寸或会导致过大解码分配的图像。
 * @param width 图像宽度。
 * @param height 图像高度。
 * @throws Error 图像尺寸无效或超过头像处理上限。
 */
function validate_dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > max_avatar_dimension || height > max_avatar_dimension || width * height > max_avatar_pixels) {
    throw new Error('头像图片尺寸无效或过大，请选择不超过 3200 万像素的图片。');
  }
}

/**
 * @brief 计算保留图像中心的正方形裁剪区域。
 * @param width 已解码图像宽度。
 * @param height 已解码图像高度。
 * @returns 使用整数像素的裁剪矩形。
 * @throws Error 图像尺寸无效或过大。
 */
export function avatar_crop(width: number, height: number): { x: number; y: number; width: number; height: number } {
  validate_dimensions(width, height);
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side };
}

/**
 * @brief 提取 PNG 或 JPEG 的尺寸，在解码前拒绝伪装格式和危险尺寸。
 * @param bytes 完整原文件内容，至多 5 MiB。
 * @returns 通过容器头和尺寸预检的元数据，不代表像素流已完成解码。
 * @throws Error 格式不受支持、头部截断或图像尺寸无效。
 */
export function inspect_avatar_image(bytes: Buffer): avatar_metadata {
  if (!bytes.length || bytes.length > max_avatar_bytes) throw new Error('头像文件必须大于 0 字节且不超过 5 MiB。');
  let metadata: avatar_metadata | undefined;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    metadata = { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) ++offset;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8 || bytes[offset + 7] === 0 || length !== 8 + bytes[offset + 7] * 3) break;
        metadata = { format: 'jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        break;
      }
      offset += length;
    }
  }
  if (!metadata) throw new Error('请选择有效的 PNG 或 JPEG 图片。');
  validate_dimensions(metadata.width, metadata.height);
  return metadata;
}

/**
 * @brief 逐段验证头像路径，拒绝符号链接、目录联接和非普通文件。
 * @param selected 已规范化的绝对本地路径。
 * @returns 检查全部路径段后的 Promise。
 * @throws Error 路径为链接、非普通文件或不可访问。
 */
async function verify_avatar_path(selected: string): Promise<void> {
  const root = path.parse(selected).root;
  let current = root;
  for (const segment of path.relative(root, selected).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const information = await fs.lstat(current);
    if (information.isSymbolicLink()) throw new Error('头像路径不能是符号链接或目录联接，请选择实际图片文件。');
    if (current === selected && !information.isFile()) throw new Error('头像必须是普通图片文件。');
  }
}

/**
 * @brief 仅读取用户指定的头像文件，无需打开项目，也不访问远端 URL。
 * @param value 用户通过自定义文件选择器选定的绝对本地路径。
 * @returns 通过路径、大小、文件身份和容器头检查的原文件字节。
 * @throws Error 路径无效、文件变化、超过 5 MiB、为链接或格式不匹配。
 */
export async function read_avatar_file(value: string): Promise<Buffer> {
  if (typeof value !== 'string' || !value || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value) ||
      (process.platform === 'win32' && (!/^[a-z]:[\\/]/iu.test(value) || value.slice(2).includes(':')))) {
    throw new Error('请选择有效的绝对本地图片路径。');
  }
  const selected = path.resolve(value);
  const extension = path.extname(selected).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('头像仅支持 PNG 或 JPEG 图片。');
  await verify_avatar_path(selected);
  const file = await fs.open(selected, 'r');
  try {
    const information = await file.stat();
    if (!information.isFile()) throw new Error('头像必须是普通图片文件。');
    if (information.size < 1 || information.size > max_avatar_bytes) throw new Error('头像文件必须大于 0 字节且不超过 5 MiB。');
    await verify_avatar_path(selected);
    const current = await fs.lstat(selected);
    if (current.dev !== information.dev || current.ino !== information.ino || current.size !== information.size) {
      throw new Error('头像文件在打开期间发生变化，请重新选择。');
    }
    const bytes = Buffer.alloc(information.size);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    if (count !== bytes.length || after.size !== information.size || after.mtimeMs !== information.mtimeMs || after.ctimeMs !== information.ctimeMs) {
      throw new Error('头像文件在读取期间发生变化，请重新选择。');
    }
    const metadata = inspect_avatar_image(bytes);
    if (extension !== `.${metadata.format}` && !(metadata.format === 'jpeg' && extension === '.jpg')) {
      throw new Error('头像文件扩展名与图片内容不一致，请选择原始图片。');
    }
    return bytes;
  } finally { await file.close(); }
}
