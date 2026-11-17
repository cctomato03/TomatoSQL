import type { TableInfo } from "./types";

/** 左侧库/表树缓存：折叠后再次展开无需重新查询；断开连接或刷新时清空 */
export const dbCache = new Map<string, string[]>();
export const tableCache = new Map<string, TableInfo[]>();

export function invalidateConnCache(connId: string) {
  dbCache.delete(connId);
  for (const key of [...tableCache.keys()]) {
    if (key.startsWith(`${connId}:`)) tableCache.delete(key);
  }
}

export function cacheKey(connId: string, database: string) {
  return `${connId}:${database}`;
}
