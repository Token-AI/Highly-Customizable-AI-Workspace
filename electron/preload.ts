/**
 * @file preload.ts
 * @brief 向隔离的本地界面暴露固定 IPC 桥接，不泄露 Electron 事件对象。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { ai_code_bridge, app_action, app_event } from '../shared/types';

/** @brief 本地界面仅可调用动作分发和订阅应用事件。 */
const bridge: ai_code_bridge = Object.freeze({
  /**
   * @brief 将动作交由主进程验证来源、参数及操作权限。
   * @param action 符合共享协议的应用动作。
   * @returns 主进程返回的动作结果。
   * @throws Error 主进程拒绝请求或操作失败时 Promise 拒绝。
   */
  invoke<t = unknown>(action: app_action): Promise<t> {
    return ipcRenderer.invoke('ai-code:action', action) as Promise<t>;
  },
  /**
   * @brief 订阅应用事件，仅转交事件数据而不暴露 ipcRenderer。
   * @param callback 接收共享协议事件的处理器。
   * @returns 解除本次订阅的函数。
   * @throws TypeError callback 不是函数。
   */
  on_event(callback: (event: app_event) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('事件处理器必须是函数。');
    const listener = (_event: Electron.IpcRendererEvent, value: app_event): void => callback(value);
    ipcRenderer.on('ai-code:event', listener);
    return () => { ipcRenderer.removeListener('ai-code:event', listener); };
  },
});

contextBridge.exposeInMainWorld('ai_code', bridge);
