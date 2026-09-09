/**
 * @file protocol_smoke.ts
 * @brief Checks the installed official Codex protocol using a new isolated data directory.
 *
 * This optional integration test is separate from fixture tests. It reads account
 * and model metadata and persists one fixed local history item, but never logs in
 * or sends turn/start. Its local fixture thread is archived before shutdown.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { codex_backend } from '../backend.js';

let stage = 'setup';
/**
 * @brief Verifies metadata, persisted-thread APIs and the controller's history restoration.
 * @returns After successful checks, fixture archival and complete backend disposal.
 * @throws Error If the isolated account is authenticated or a protocol/schema check fails.
 * @throws rpc_failure If an allowlisted metadata or local-history RPC is rejected or times out.
 */
async function main(): Promise<void> {
  const base = path.resolve('build', 'electron-smoke-home');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'run-'));
  const home = path.join(directory, 'codex'), cwd = path.join(directory, 'workspace'), secondary = path.join(directory, 'secondary_workspace');
  await mkdir(cwd, { recursive: true }); await mkdir(secondary, { recursive: true });
  const backend = new codex_backend({ cwd, home, emit: () => {},
    open_login: async () => { throw new Error('The metadata smoke check must never open login.'); }, close_login: () => {},
    request_timeout_ms: 20_000,
  });
  let thread_id = '';
  type probe_method = 'model/list' | 'thread/start' | 'thread/inject_items' | 'thread/list' | 'thread/resume' | 'thread/read' | 'thread/items/list' | 'thread/turns/list' | 'thread/archive';
  const metadata = backend as unknown as {
    request(method: probe_method, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    thread_options(): Record<string, unknown>;
  };
  /**
   * @brief Records a safe diagnostic stage before one explicitly allowlisted test RPC.
   * @param method Metadata or local-history method; no login or model-turn method is allowed.
   * @param params Official wire-format parameters for the selected method.
   * @returns The corresponding JSON-RPC result object.
   * @throws rpc_failure When the selected RPC fails.
   */
  const probe = (method: probe_method, params: Record<string, unknown>) => { stage = method; return metadata.request(method, params); };
  try {
    stage = 'initialize / account/read';
    await backend.connect();
    if (!backend.state.connected) throw new Error('The isolated Codex app-server handshake did not complete.');
    if (backend.state.authenticated) throw new Error('Expected an unauthenticated isolated account; no account data was displayed.');
    console.log('initialize / initialized: passed');
    console.log('account/read: unauthenticated as expected');
    /// Test-only access to a fixed RPC allowlist; this probe is never exposed over IPC.
    const models = await probe('model/list', { limit: 20, includeHidden: false });
    if (!Array.isArray(models.data) || !models.data.every(value => value && typeof value === 'object' &&
        typeof (value as Record<string, unknown>).id === 'string' && typeof (value as Record<string, unknown>).model === 'string'))
      throw new Error('model/list metadata did not match the expected schema.');
    console.log(`model/list: ${models.data.length} model records; metadata only`);
    await backend.set_directories([cwd, secondary]); backend.set_mode('workspace-write');
    const thread_options = metadata.thread_options();
    if (thread_options.sandbox !== 'workspace-write' || !String(thread_options.developerInstructions).includes(JSON.stringify(secondary)))
      throw new Error('Multi-directory thread options omitted the selected project context.');
    const started = await probe('thread/start', { ...thread_options, model: (models.data[0] as Record<string, unknown> | undefined)?.model });
    thread_id = String((started.thread as Record<string, unknown> | undefined)?.id ?? '');
    if (!thread_id) throw new Error('Empty thread/start returned no thread identifier.');
    /// A new empty thread exists only in memory. The fixed local context item
    /// creates its rollout without starting a turn or requesting a model.
    await probe('thread/inject_items', { threadId: thread_id, items: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'AI Code local protocol fixture. No model request.' }] }] });
    const listed = await probe('thread/list', { limit: 100, archived: false, sourceKinds: ['appServer', 'cli', 'vscode'] });
    if (!Array.isArray(listed.data)) throw new Error('thread/list returned no data array.');
    const resumed = await probe('thread/resume', { ...thread_options, threadId: thread_id, excludeTurns: true });
    if ((resumed.thread as Record<string, unknown> | undefined)?.id !== thread_id) throw new Error('thread/resume returned another thread.');
    const stable = await probe('thread/read', { threadId: thread_id, includeTurns: true });
    if (!Array.isArray((stable.thread as Record<string, unknown> | undefined)?.turns)) throw new Error('Stable thread/read returned no turns array.');
    for (const method of ['thread/items/list', 'thread/turns/list'] as const) {
      const page = await probe(method, { threadId: thread_id, limit: 10, sortDirection: 'desc', ...(method === 'thread/turns/list' ? { itemsView: 'notLoaded' } : {}) });
      if (!Array.isArray(page.data) || page.data.length !== 0) throw new Error('An empty smoke thread unexpectedly contains generated content.');
    }
    stage = 'codex_backend.resume';
    await backend.resume(thread_id, [cwd, secondary]);
    if (backend.state.thread_id !== thread_id || backend.state.session_loading || backend.state.busy) throw new Error('Backend did not restore the local fixture thread.');
    if (backend.state.workspace_roots?.length !== 2) throw new Error('Explicit project roots were not retained during history restoration.');
    await probe('thread/archive', { threadId: thread_id }); thread_id = '';
    console.log('local thread/start / inject_items / list / resume / stable read / item and turn pages / archive: passed; no generation');
    console.log('multi-directory thread options / backend history restore: passed; no sandbox commands or model turns');
    console.log('Electron backend protocol smoke: passed; no login, generation, or existing credential access');
  } finally {
    if (thread_id && backend.state.connected) { try { await metadata.request('thread/archive', { threadId: thread_id }); } catch { /* Isolated smoke directory only. */ } }
    await backend.dispose();
  }
}

main().catch(error => {
  /// Report only the known stage and error category, never raw account data or URLs.
  const message = error instanceof Error ? error.message : '';
  const category = /no rollout found/i.test(message) ? 'rollout is not persisted' :
    /experimental|not supported|unsupported/i.test(message) ? 'protocol or store capability is unavailable' :
    /timeout|超时/i.test(message) ? 'request timed out' : 'request or schema validation failed';
  console.error(`Electron backend protocol smoke did not pass at ${stage}: ${category}; no login or model generation was attempted.`);
  process.exitCode = 1;
});
