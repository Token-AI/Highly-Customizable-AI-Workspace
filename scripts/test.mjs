import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * @brief Discover compiled test modules beneath one output directory.
 * @param {string} directory Absolute directory to search.
 * @returns {string[]} Absolute test module paths.
 */
function collect_tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file_path = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect_tests(file_path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [file_path] : [];
  });
}

/**
 * @brief Run the compiled main-process and renderer tests with Node's test runner.
 * @returns {void} Exits with the test runner's status.
 */
export function run_tests() {
  const project_root = fileURLToPath(new URL('../', import.meta.url));
  const test_files = ['electron', 'renderer'].flatMap(name => collect_tests(path.join(project_root, 'dist', name))).sort();
  if (!test_files.length) throw new Error('No compiled *.test.js files were found.');
  const result = spawnSync(process.execPath, ['--test', ...test_files], { cwd: project_root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

run_tests();
