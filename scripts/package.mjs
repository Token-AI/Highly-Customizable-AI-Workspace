import { packager } from '@electron/packager';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const project_root = fileURLToPath(new URL('../', import.meta.url));

/**
 * @brief Resolve a package output directory restricted to this project's build/packages tree.
 * @param {string[]} output_arguments Optional --out followed by an output directory.
 * @returns {string} Validated absolute output directory without creating or changing files.
 */
export function resolve_package_output(output_arguments = []) {
  if (output_arguments.length !== 0 && (output_arguments.length !== 2 || output_arguments[0] !== '--out' || !output_arguments[1]?.trim() || output_arguments[1].startsWith('--'))) {
    throw new Error('Usage: node scripts/package.mjs [--out build/packages/<directory>]');
  }
  const packages_root = path.resolve(project_root, 'build/packages');
  const output_directory = output_arguments.length ? path.resolve(project_root, output_arguments[1]) : packages_root;
  const relative_output = path.relative(packages_root, output_directory);
  if (relative_output === '..' || relative_output.startsWith('..' + path.sep) || path.isAbsolute(relative_output)) {
    throw new Error('Package output must stay inside this project\'s build/packages directory.');
  }
  let current_directory = project_root;
  for (const segment of path.relative(project_root, output_directory).split(path.sep)) {
    current_directory = path.join(current_directory, segment);
    let directory_info;
    try { directory_info = lstatSync(current_directory); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (directory_info.isSymbolicLink() || !directory_info.isDirectory()) {
      throw new Error('Package output cannot pass through a symbolic link, junction, or file.');
    }
  }
  return output_directory;
}

/**
 * @brief Build a Windows application directory from compiled production files.
 * @param {string[]} output_arguments Optional --out followed by an output directory.
 * @returns {Promise<void>} Completes after the package paths have been printed.
 */
export async function package_application(output_arguments = []) {
  const output_directory = resolve_package_output(output_arguments);
  const package_manifest = JSON.parse(readFileSync(path.join(project_root, 'package.json'), 'utf8'));
  const package_paths = await packager({
    dir: project_root, name: 'AI Code', executableName: 'ai-code', platform: 'win32', arch: 'x64',
    electronVersion: package_manifest.devDependencies.electron.replace(/^[~^]/, ''),
    out: output_directory, overwrite: false, asar: true, prune: true,
    tmpdir: path.join(project_root, 'build/packager-temp'),
    download: { cacheRoot: path.join(project_root, 'build/electron-cache') },
    ignore: candidate => {
      const file_path = candidate.replaceAll('\\', '/');
      if (/^\/dist\/(?:electron|renderer)\/tests(?:\/|$)/.test(file_path) || /\.test\.js(?:\.map)?$/.test(file_path)) return true;
      return file_path !== '' && !/^\/(?:dist(?:\/|$)|package\.json$)/.test(file_path);
    },
    win32metadata: { CompanyName: 'AI Code', FileDescription: 'AI Code Desktop', ProductName: 'AI Code' }
  });
  for (const package_path of package_paths) console.log(package_path);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await package_application(process.argv.slice(2));
}
