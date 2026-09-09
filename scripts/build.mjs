import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * @brief Compile both TypeScript processes and copy the renderer's static assets.
 * @returns {void} Returns when the application has been built successfully.
 */
export function build_application() {
  const project_root = fileURLToPath(new URL('../', import.meta.url));
  const output_directory = path.resolve(project_root, 'dist');
  const compiler_path = path.join(project_root, 'node_modules/typescript/bin/tsc');
  if (!existsSync(compiler_path)) throw new Error('TypeScript is not installed. Run .\\scripts\\install.ps1 first.');
  for (const source_file of ['electron/main.ts', 'renderer/index.html', 'renderer/styles.css']) {
    if (!existsSync(path.join(project_root, source_file))) throw new Error(`Required source is missing: ${source_file}`);
  }
  const relative_output = path.relative(project_root, output_directory);
  if (!relative_output || relative_output.startsWith('..') || path.isAbsolute(relative_output)) throw new Error('Refusing to clean outside this project.');
  rmSync(output_directory, { recursive: true, force: true });
  for (const compiler_config of ['tsconfig.electron.json', 'tsconfig.renderer.json']) {
    const result = spawnSync(process.execPath, [compiler_path, '-p', compiler_config], { cwd: project_root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const renderer_directory = path.join(output_directory, 'renderer');
  mkdirSync(renderer_directory, { recursive: true });
  for (const source_file of ['index.html', 'styles.css']) cpSync(path.join(project_root, 'renderer', source_file), path.join(renderer_directory, source_file));
  if (existsSync(path.join(project_root, 'renderer/assets'))) cpSync(path.join(project_root, 'renderer/assets'), path.join(renderer_directory, 'assets'), { recursive: true });
  writeFileSync(path.join(renderer_directory, 'package.json'), '{"type":"module"}\n', 'utf8');
  console.log('Built Electron CommonJS, renderer ES modules, and static assets in dist/.');
}

build_application();
