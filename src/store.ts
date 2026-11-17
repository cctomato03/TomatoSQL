import { create } from "zustand";
import { api } from "./api";
import { applyTheme } from "./themes";
import type { AppInfo, Connection, Group, Settings, TestResult, Workspace } from "./types";

export type TabKind = "welcome" | "connection" | "table" | "query";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  connId?: string;
  database?: string;
  table?: string;
  sql?: string;
}

export interface Toast {
  id: number;
  kind: "info" | "ok" | "err";
  text: string;
}

export const DEFAULT_SETTINGS: Settings = {
  themeId: "tomato-light",
  fontSize: 13,
  editorFontSize: 13,
  rowHeight: 26,
  pageSize: 500,
  confirmDestructive: true,
  showLineNumbers: true,
  language: "zh",
  cloud: { serverUrl: "", username: "", token: null, lastSyncAt: null, autoPush: false },
};

export function emptyWorkspace(): Workspace {
  return {
    version: 1,
    groups: [],
    connections: [],
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: Date.now(),
  };
}

export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newConnection(kind: "mysql" | "sqlite"): Connection {
  const ts = Date.now();
  if (kind === "sqlite") {
    return {
      id: uid(),
      name: "新建 SQLite 连接",
      kind: "sqlite",
      groupId: null,
      file: "",
      readOnly: false,
      color: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }
  return {
    id: uid(),
    name: "新建 MySQL 连接",
    kind: "mysql",
    groupId: null,
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    charset: "utf8mb4",
    sslMode: "disabled",
    database: "",
    color: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

interface Store {
  ready: boolean;
  ws: Workspace;
  info: AppInfo | null;
  tabs: Tab[];
  activeTab: string;
  /** connId -> engine（已打开的连接） */
  connected: Record<string, string>;
  busy: Record<string, boolean>;
  toasts: Toast[];
  selectedConnId: string | null;

  init: () => Promise<void>;
  persist: () => void;

  setSettings: (patch: Partial<Settings>) => void;
  upsertConnection: (conn: Connection) => void;
  removeConnection: (id: string) => void;
  upsertGroup: (group: Group) => void;
  removeGroup: (id: string, deleteChildren: boolean) => void;
  replaceWorkspace: (ws: Workspace) => void;

  openTab: (tab: Omit<Tab, "id"> & { id?: string }) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<Tab>) => void;
  closeTabsOfConn: (connId: string) => void;

  setConnected: (connId: string, engine: string | null) => void;
  setBusy: (key: string, value: boolean) => void;
  selectConn: (id: string | null) => void;

  notify: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => ({
  ready: false,
  ws: emptyWorkspace(),
  info: null,
  tabs: [{ id: "welcome", kind: "welcome", title: "欢迎" }],
  activeTab: "welcome",
  connected: {},
  busy: {},
  toasts: [],
  selectedConnId: null,

  init: async () => {
    try {
      const [ws, info] = await Promise.all([
        api.loadWorkspace().catch(() => emptyWorkspace()),
        api.appInfo().catch(() => null),
      ]);
      const merged: Workspace = {
        ...emptyWorkspace(),
        ...ws,
        settings: { ...DEFAULT_SETTINGS, ...(ws.settings ?? {}), cloud: { ...DEFAULT_SETTINGS.cloud, ...(ws.settings?.cloud ?? {}) } },
      };
      applyTheme(merged.settings.themeId, merged.settings.fontSize, merged.settings.editorFontSize);
      set({ ws: merged, info, ready: true });
    } catch (e) {
      applyTheme("tomato-light", 13, 13);
      set({ ready: true });
      get().notify(String(e), "err");
    }
  },

  persist: () => {
    const ws = { ...get().ws, updatedAt: Date.now() };
    set({ ws });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.saveWorkspace(get().ws).catch((e) => get().notify(`保存失败：${e}`, "err"));
    }, 250);
  },

  setSettings: (patch) => {
    const settings = { ...get().ws.settings, ...patch };
    set({ ws: { ...get().ws, settings } });
    applyTheme(settings.themeId, settings.fontSize, settings.editorFontSize);
    get().persist();
  },

  upsertConnection: (conn) => {
    const ws = get().ws;
    const idx = ws.connections.findIndex((c) => c.id === conn.id);
    const connections = [...ws.connections];
    const next = { ...conn, updatedAt: Date.now() };
    if (idx >= 0) connections[idx] = next;
    else connections.push(next);
    set({ ws: { ...ws, connections } });
    get().persist();
  },

  removeConnection: (id) => {
    const ws = get().ws;
    set({ ws: { ...ws, connections: ws.connections.filter((c) => c.id !== id) } });
    api.disconnect(id).catch(() => void 0);
    const connected = { ...get().connected };
    delete connected[id];
    set({ connected });
    get().closeTabsOfConn(id);
    get().persist();
  },

  upsertGroup: (group) => {
    const ws = get().ws;
    const idx = ws.groups.findIndex((g) => g.id === group.id);
    const groups = [...ws.groups];
    if (idx >= 0) groups[idx] = group;
    else groups.push(group);
    set({ ws: { ...ws, groups } });
    get().persist();
  },

  removeGroup: (id, deleteChildren) => {
    const ws = get().ws;
    const groups = ws.groups.filter((g) => g.id !== id && g.parentId !== id);
    const connections = deleteChildren
      ? ws.connections.filter((c) => c.groupId !== id)
      : ws.connections.map((c) => (c.groupId === id ? { ...c, groupId: null } : c));
    set({ ws: { ...ws, groups, connections } });
    get().persist();
  },

  replaceWorkspace: (ws) => {
    const merged: Workspace = {
      ...emptyWorkspace(),
      ...ws,
      settings: { ...get().ws.settings, ...ws.settings },
    };
    set({ ws: merged, tabs: [{ id: "welcome", kind: "welcome", title: "欢迎" }], activeTab: "welcome", connected: {} });
    applyTheme(merged.settings.themeId, merged.settings.fontSize, merged.settings.editorFontSize);
    get().persist();
  },

  openTab: (tab) => {
    const id =
      tab.id ??
      (tab.kind === "query"
        ? `query-${uid()}`
        : `${tab.kind}:${tab.connId ?? ""}:${tab.database ?? ""}:${tab.table ?? ""}`);
    const exists = get().tabs.find((t) => t.id === id);
    if (!exists) {
      set({ tabs: [...get().tabs, { ...tab, id }] });
    } else if (tab.kind === "query") {
      // 查询 tab 复用同一个 id 时更新内容
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...tab, id } : t)) });
    }
    set({ activeTab: id });
  },

  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id);
    const nextTabs = tabs.length ? tabs : [{ id: "welcome", kind: "welcome" as TabKind, title: "欢迎" }];
    let active = get().activeTab;
    if (active === id) {
      active = nextTabs[Math.max(0, nextTabs.length - 1)].id;
    }
    set({ tabs: nextTabs, activeTab: active });
  },

  activateTab: (id) => set({ activeTab: id }),

  patchTab: (id, patch) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),

  closeTabsOfConn: (connId) => {
    const remaining = get().tabs.filter((t) => t.connId !== connId);
    const nextTabs = remaining.length
      ? remaining
      : [{ id: "welcome", kind: "welcome" as TabKind, title: "欢迎" }];
    const activeStillOpen = nextTabs.some((t) => t.id === get().activeTab);
    set({
      tabs: nextTabs,
      activeTab: activeStillOpen ? get().activeTab : nextTabs[nextTabs.length - 1].id,
    });
  },

  setConnected: (connId, engine) => {
    const connected = { ...get().connected };
    if (engine) connected[connId] = engine;
    else delete connected[connId];
    set({ connected });
  },

  setBusy: (key, value) => set({ busy: { ...get().busy, [key]: value } }),

  selectConn: (id) => set({ selectedConnId: id }),

  notify: (text, kind = "info") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === "err" ? 8000 : 4000);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** 连接前确保密码等字段完整 */
export function toTestResult(r: TestResult): string {
  return r.version ? `${r.message}（${r.version}，${r.latencyMs}ms）` : `${r.message}（${r.latencyMs}ms）`;
}
