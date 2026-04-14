import path from "node:path";
import { readJson } from "./fsx.js";

export interface FirstInstallBootstrapMarker {
  done?: boolean;
  at?: string;
  note?: string;
  /**
   * 首装回填 pipeline 中成功执行 rotate 的日历日（升序）。
   * 供 rollback-first-install-backfill 逆序回滚使用。
   */
  rotatedDateKeysAsc?: string[];
}

export function firstInstallBootstrapStatePath(stateDir: string): string {
  return path.join(stateDir, "first-install-bootstrap.json");
}

export function readFirstInstallMarker(stateDir: string): FirstInstallBootstrapMarker {
  return readJson<FirstInstallBootstrapMarker>(firstInstallBootstrapStatePath(stateDir), {});
}

/** 从 runDailyRotatePipeline 的 batch 结果中收集 status 为 ok / ok_no_delete 的 dateKey（去重、升序）。 */
export function collectSuccessfulRotateDateKeysFromBatch(
  batch: Array<{ results: unknown[] }>,
): string[] {
  const keys: string[] = [];
  for (const b of batch) {
    for (const r of b.results) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const status = o.status;
      const dk = typeof o.dateKey === "string" ? o.dateKey.trim() : "";
      if (!dk) continue;
      if (status === "ok" || status === "ok_no_delete") {
        keys.push(dk);
      }
    }
  }
  return [...new Set(keys)].sort();
}
