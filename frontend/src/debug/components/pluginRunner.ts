/** 插件抽屉几页共用的小工具:跑一个改后端数据的操作、报错、刷新列表 */

import { useState } from 'react';

export type Notify = (kind: 'ok' | 'error', message: string) => void;

export type Runner = (label: string, fn: () => Promise<void>) => Promise<boolean>;

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** 跑一个操作,完了刷新列表。返回操作本身有没有成功 */
export function useRunner(notify: Notify, reload: () => Promise<void>): [string | null, Runner] {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    let ok = false;
    try {
      await fn();
      ok = true;
    } catch (e) {
      notify('error', errText(e));
    } finally {
      try {
        await reload();
      } catch {
        // 刷新失败就保留旧列表,上面已经报过错了
      }
      setBusy(null);
    }
    return ok;
  };
  return [busy, run];
}
