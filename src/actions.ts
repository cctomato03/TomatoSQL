import { api } from "./api";
import { useStore } from "./store";
import type { Connection } from "./types";

/** 连接数据库（幂等：已连接则直接打开标签页） */
export async function connectTo(conn: Connection, openTab = true): Promise<boolean> {
  const store = useStore.getState();
  if (store.connected[conn.id]) {
    if (openTab) {
      store.openTab({
        kind: "connection",
        connId: conn.id,
        title: conn.name || "连接",
      });
    }
    return true;
  }
  store.setBusy(`conn:${conn.id}`, true);
  try {
    const engine = await api.connect(conn.id, conn);
    store.setConnected(conn.id, engine);
    if (openTab) {
      store.openTab({ kind: "connection", connId: conn.id, title: conn.name || "连接" });
    }
    return true;
  } catch (e) {
    store.notify(`连接失败：${e}`, "err");
    return false;
  } finally {
    store.setBusy(`conn:${conn.id}`, false);
  }
}

export async function disconnectFrom(connId: string) {
  const store = useStore.getState();
  try {
    await api.disconnect(connId);
  } catch {
    /* 忽略断开错误 */
  }
  store.setConnected(connId, null);
  store.closeTabsOfConn(connId);
}

export function openTable(conn: Connection, database: string, table: string) {
  useStore.getState().openTab({
    kind: "table",
    connId: conn.id,
    database,
    table,
    title: table,
  });
}

export function openQuery(conn: Connection, database: string, sql = "") {
  const store = useStore.getState();
  store.openTab({
    kind: "query",
    connId: conn.id,
    database,
    sql,
    title: `查询 · ${database || conn.name}`,
  });
}

export function openConnectionView(conn: Connection) {
  useStore.getState().openTab({ kind: "connection", connId: conn.id, title: conn.name || "连接" });
}
