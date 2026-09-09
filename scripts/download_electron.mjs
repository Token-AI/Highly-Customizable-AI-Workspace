import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { downloadArtifact } from '@electron/get';

const project_root = fileURLToPath(new URL('../', import.meta.url));
const cache_root = path.join(project_root, 'build/electron-cache');
const pieces_root = path.join(cache_root, 'parallel-pieces');
const temp_root = path.join(project_root, 'build/electron-temp');
const piece_bytes = 4 * 1024 * 1024;
const connections = 32;

/** @brief Execute a background command without a shell. @param executable Executable path. @param args Argument array. @param env Child environment. @returns Captured output and exit code. */
async function run_command(executable, args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: project_root, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

/** @brief Compute a local artifact SHA256. @param file Artifact path. @returns Lowercase checksum. */
async function sha256_file(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** @brief Download the official Windows runtime in validated ranges and install it. @returns Completion when the verified runtime is installed. */
export async function download_electron() {
  const package_data = JSON.parse(await readFile(path.join(project_root, 'node_modules/electron/package.json'), 'utf8'));
  const version = package_data.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable Electron package version is required.');
  const artifact_name = `electron-v${version}-win32-x64.zip`;
  const source_url = `https://github.com/electron/electron/releases/download/v${version}/${artifact_name}`;
  const checksums = JSON.parse(await readFile(path.join(project_root, 'node_modules/electron/checksums.json'), 'utf8'));
  const expected_sha = checksums[artifact_name];
  if (!/^[a-f0-9]{64}$/i.test(expected_sha ?? '')) throw new Error('The installed official Electron package has no artifact checksum.');
  for (const directory of [cache_root, pieces_root, temp_root]) await mkdir(directory, { recursive: true });
  const headers = await run_command('curl.exe', ['--head', '--location', '--silent', '--show-error', '--max-time', '45', source_url]);
  if (headers.code !== 0) throw new Error('Official artifact header request failed.');
  const sizes = [...headers.stdout.matchAll(/^content-length:\s*(\d+)/gim)];
  const total_bytes = Number(sizes.at(-1)?.[1]);
  if (!Number.isSafeInteger(total_bytes) || total_bytes < 1000000 || !/^accept-ranges:\s*bytes/im.test(headers.stdout)) {
    throw new Error('Official server did not confirm content length and byte ranges.');
  }
  const parts = Array.from({ length: Math.ceil(total_bytes / piece_bytes) }, (_, index) => ({
    index, start: index * piece_bytes, end: Math.min((index + 1) * piece_bytes, total_bytes) - 1,
    file: path.join(pieces_root, `part-${String(index).padStart(3, '0')}.bin`)
  }));
  let cursor = 0;
  let completed = 0;
  let active = 0;
  let failed = false;
  const started_at = Date.now();
  console.log(`Official artifact: ${artifact_name}; ${total_bytes} bytes; ${parts.length} ranges; ${connections} connections.`);

  /** @brief Fetch and validate one HTTP byte range. @param part Expected range and local file. @returns Completion after exact range and length validation. */
  async function fetch_part(part) {
    const required_bytes = part.end - part.start + 1;
    try {
      const saved_meta = JSON.parse(await readFile(part.file + '.json', 'utf8'));
      if ((await stat(part.file)).size === required_bytes && saved_meta.start === part.start && saved_meta.end === part.end && saved_meta.total === total_bytes && saved_meta.sha === expected_sha) return;
    } catch {}
    const temporary_file = part.file + '.download';
    const header_file = part.file + '.headers';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await run_command('curl.exe', [
        '--location', '--fail', '--silent', '--show-error', '--connect-timeout', '30', '--max-time', '600',
        '--max-filesize', String(required_bytes), '--range', `${part.start}-${part.end}`,
        '--dump-header', header_file, '--output', temporary_file, '--write-out', '%{http_code}', source_url
      ]);
      let valid_range = false;
      try {
        const part_headers = await readFile(header_file, 'utf8');
        const ranges = [...part_headers.matchAll(/^content-range:\s*bytes\s+(\d+)-(\d+)\/(\d+)/gim)];
        const received = ranges.at(-1);
        valid_range = result.stdout.trim() === '206' && Number(received?.[1]) === part.start && Number(received?.[2]) === part.end && Number(received?.[3]) === total_bytes && (await stat(temporary_file)).size === required_bytes;
      } catch {}
      if (result.code === 0 && valid_range) {
        await rename(temporary_file, part.file);
        const metadata_file = await open(part.file + '.json', 'w');
        try { await metadata_file.writeFile(JSON.stringify({ start: part.start, end: part.end, total: total_bytes, sha: expected_sha })); } finally { await metadata_file.close(); }
        await unlink(header_file).catch(() => {});
        return;
      }
      console.log(`Range ${part.index} retry ${attempt}/3 (curl ${result.code}, exact range ${valid_range}).`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
    throw new Error(`Range ${part.index} failed validation after three attempts.`);
  }

  /** @brief Consume the shared range queue. @returns Completion when this worker has no further ranges. */
  async function worker() {
    while (!failed) {
      const index = cursor++;
      if (index >= parts.length) return;
      active++;
      try {
        await fetch_part(parts[index]);
        completed++;
        console.log(`Verified range ${completed}/${parts.length}; segment ${index}.`);
      } catch (error) { failed = true; throw error; }
      finally { active--; }
    }
  }

  const progress_timer = setInterval(() => {
    console.log(`Download progress: ${completed}/${parts.length} verified, ${active} active, ${Math.round((Date.now() - started_at) / 1000)}s.`);
  }, 10000);
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(connections, parts.length) }, worker));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  } finally { clearInterval(progress_timer); }
  const archive_path = path.join(cache_root, artifact_name);
  const archive = await open(archive_path, 'w');
  try {
    for (const part of parts) {
      for await (const chunk of createReadStream(part.file)) {
        let offset = 0;
        while (offset < chunk.length) {
          const result = await archive.write(chunk, offset, chunk.length - offset);
          offset += result.bytesWritten;
        }
      }
    }
  } finally { await archive.close(); }
  if ((await stat(archive_path)).size !== total_bytes || await sha256_file(archive_path) !== expected_sha.toLowerCase()) throw new Error('Full artifact SHA256 validation failed; runtime will not be installed.');
  console.log(`Full SHA256 verified: ${expected_sha}.`);
  const cached_path = await downloadArtifact({
    version, artifactName: 'electron', platform: 'win32', arch: 'x64', cacheRoot: cache_root,
    tempDirectory: temp_root, checksums,
    downloader: { download: async (requested_url, target_file) => {
      if (requested_url !== source_url) throw new Error('Refusing a non-official or unexpected artifact URL.');
      await copyFile(archive_path, target_file);
    } }
  });
  console.log(`Imported into official cache: ${path.relative(project_root, cached_path)}.`);
  const installer_env = { ...process.env, electron_config_cache: cache_root, ELECTRON_CACHE: cache_root };
  const installation = await run_command(process.execPath, [path.join(project_root, 'node_modules/electron/install.js')], installer_env);
  if (installation.code !== 0) throw new Error('Official installer failed: ' + installation.stderr.slice(0, 800));
  console.log('Official Electron runtime extracted in node_modules/electron/dist.');
}

await download_electron();
