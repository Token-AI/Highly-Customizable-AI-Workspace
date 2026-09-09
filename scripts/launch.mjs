import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/**
 * @brief Launch the installed Electron runtime without changing existing processes.
 * @param {string[]} launch_arguments Application arguments to pass through.
 * @returns {void} Mirrors the application's exit status when it closes.
 */
export function launch_application(launch_arguments) {
  const require_module = createRequire(import.meta.url);
  const child_environment = { ...process.env };
  delete child_environment.ELECTRON_RUN_AS_NODE;
  const child_process = spawn(require_module('electron'), ['.', ...launch_arguments], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: child_environment, stdio: 'inherit'
  });
  child_process.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child_process.on('exit', exit_code => { process.exitCode = exit_code ?? 1; });
}

launch_application(process.argv.slice(2));
