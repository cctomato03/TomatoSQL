import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ChevronRight,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  FunctionSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Table2,
  TerminalSquare,
  Trash2,
  Upload,
  Download,
} from "lucide-react";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { cacheKey, dbCache, invalidateConnCache, tableCache } from "../explorerCache";
import { useStore } from "../store";
import type { Connection, RoutineInfo, TableInfo, BackupFile } from "../types";
import { ContextMenu, type MenuItemSpec } from "./ui";
import { confirmDialog } from "./confirm";
import { connectTo } from "../actions";

export { invalidateConnCache };

interface Props {
  conn: Connection;
  onOpenTable: (database: string, table: string) => void;
  onOpenQuery: (database: string, sql?: string) => void;
  onImport: (database: string, table?: string) => void;
}

type Selection =
  | { kind: "db"; db: string }
  | { kind: "table"; db: string; table: string }
  | { kind: "query"; db: string; id: string }
  | { kind: "backup"; db: string; path: string }
  | null;

type SectionKey = "tables" | "views" | "routines" | "queries" | "backups";

/** 左侧栏里连接节点下的对象树：数据库 → 表 / 视图 / 函数 / 查询 / 备份 */
export function ConnectionExplorer({ conn, onOpenTable, onOpenQuery, onImport }: Props) {
  const notify = useStore((s) => s.notify);
  const savedQueries = useStore((s) => s.ws.savedQueries ?? []);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const removeSavedQuery = useStore((s) => s.removeSavedQuery);
  const isConnected = Boolean(useStore((s) => s.connected[conn.id]));

  const [dbs, setDbs] = useState<string[]>(() => dbCache.get(conn.id) ?? []);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [routines, setRoutines] = useState<Record<string, RoutineInfo[]>>({});
  const [backups, setBackups] = useState<Record<string, BackupFile[]>>({});
  const [loadingDb, setLoadingDb] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItemSpec[] } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadDatabases = useCallback(
    async (force = false) => {
      if (!isConnected) return;
      if (!force && dbCache.has(conn.id)) {
        setDbs(dbCache.get(conn.id)!);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await api.databases(conn.id);
        dbCache.set(conn.id, list);
        setDbs(list);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [conn.id, isConnected],
  );

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  const loadTables = useCallback(
    async (database: string, force = false) => {
      const key = cacheKey(conn.id, database);
      if (!force && tableCache.has(key)) {
        setTables((s) => ({ ...s, [database]: tableCache.get(key)! }));
        return;
      }
      setLoadingDb((s) => ({ ...s, [database]: true }));
      try {
        const list = await api.tables(conn.id, database);
        tableCache.set(key, list);
        setTables((s) => ({ ...s, [database]: list }));
      } catch (e) {
        notify(`读取表列表失败：${e}`, "err");
        setTables((s) => ({ ...s, [database]: [] }));
      } finally {
        setLoadingDb((s) => ({ ...s, [database]: false }));
      }
    },
    [conn.id, notify],
  );

  const loadRoutines = useCallback(
    async (database: string, force = false) => {
      if (!force && routines[database]) return;
      try {
        const list = await api.routines(conn.id, database);
        setRoutines((s) => ({ ...s, [database]: list }));
      } catch (e) {
        notify(`读取函数列表失败：${e}`, "err");
        setRoutines((s) => ({ ...s, [database]: [] }));
      }
    },
    [conn.id, routines, notify],
  );

  const loadBackups = useCallback(
    async (database: string) => {
      try {
        const list = await api.backupList(conn.id, database);
        setBackups((s) => ({ ...s, [database]: list }));
      } catch (e) {
        notify(`读取备份列表失败：${e}`, "err");
        setBackups((s) => ({ ...s, [database]: [] }));
      }
    },
    [conn.id, notify],
  );

  const toggleSection = async (database: string, key: SectionKey) => {
    const k = `${database}:${key}`;
    const next = !sections[k];
    setSections((s) => ({ ...s, [k]: next }));
    if (!next) return;
    if (key === "routines") await loadRoutines(database);
    if (key === "backups") await loadBackups(database);
  };

  const toggleDb = useCallback(
    async (database: string) => {
      setSel({ kind: "db", db: database });
      const next = !expanded[database];
      setExpanded((s) => ({ ...s, [database]: next }));
      if (!next) return;
      if (!isConnected) {
        const ok = await connectTo(conn);
        if (!ok) return;
      }
      void loadTables(database);
    },
    [expanded, isConnected, conn, loadTables],
  );

  const refresh = () => {
    invalidateConnCache(conn.id);
    setTables({});
    setRoutines({});
    void loadDatabases(true);
  };

  // ---------- 数据库级操作 ----------

  const exportDatabase = async (database: string, mode: "structure" | "data") => {
    const key = `${database}:${mode}`;
    setBusyKey(key);
    try {
      const list = await api.tables(conn.id, database);
      const names = list.filter((t) => t.kind === "table").map((t) => t.name);
      if (!names.length) throw new Error("该数据库没有表可导出");
      const suggested = `${database || "database"}-${mode === "structure" ? "schema" : "full"}.sql`;
      const target = await saveFile({
        defaultPath: suggested,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (typeof target !== "string") return;
      const res = await api.exportData({
        connId: conn.id,
        database,
        tables: names,
        sql: null,
        format: "sql",
        filePath: target,
        includeHeader: true,
        delimiter: ",",
        includeStructure: true,
        includeData: mode === "data",
        nullAs: null,
        batchSize: 1000,
      });
      notify(
        mode === "structure"
          ? `已导出数据库结构（${res.tables} 张表）→ ${res.filePath}`
          : `已导出数据库（结构+数据，${res.rows} 行）→ ${res.filePath}`,
        "ok",
      );
    } catch (e) {
      notify(`导出失败：${e}`, "err");
    } finally {
      setBusyKey(null);
    }
  };

  const runSqlFile = async (database: string) => {
    const picked = await openFile({
      multiple: false,
      filters: [{ name: "SQL 脚本", extensions: ["sql"] }],
    });
    if (typeof picked !== "string") return;
    setBusyKey(`${database}:runsqlfile`);
    try {
      const res = await api.importData({
        connId: conn.id,
        database,
        table: "",
        format: "sql",
        filePath: picked,
        hasHeader: false,
        delimiter: ",",
        truncateFirst: false,
        createTable: true,
        onConflict: "error",
        batchSize: 500,
        emptyAsNull: false,
      });
      notify(
        `SQL 文件执行完成：成功 ${res.inserted} 条${res.failed ? `，失败 ${res.failed} 条` : ""}`,
        res.failed ? "err" : "ok",
      );
      refresh();
    } catch (e) {
      notify(`执行失败：${e}`, "err");
    } finally {
      setBusyKey(null);
    }
  };

  const createBackup = async (database: string) => {
    setBusyKey(`${database}:backup`);
    try {
      const file = await api.backupCreate(conn.id, database);
      notify(`备份完成：${file.name}（${(file.size / 1024).toFixed(1)} KB）`, "ok");
      setSections((s) => ({ ...s, [`${database}:backups`]: true }));
      await loadBackups(database);
    } catch (e) {
      notify(`备份失败：${e}`, "err");
    } finally {
      setBusyKey(null);
    }
  };

  const restoreBackup = async (database: string, file: BackupFile) => {
    if (
      useStore.getState().ws.settings.confirmDestructive &&
      !(await confirmDialog({
        title: "恢复备份",
        message: `将执行备份文件覆盖同名表结构与数据：\n${file.name}\n\n确定继续？`,
      }))
    ) {
      return;
    }
    try {
      const res = await api.backupRestore(conn.id, database, file.path);
      notify(
        `恢复完成：执行 ${res.inserted} 条语句${res.failed ? `，失败 ${res.failed}` : ""}`,
        res.failed ? "err" : "ok",
      );
      invalidateConnCache(conn.id);
      setTables({});
      await loadTables(database, true);
    } catch (e) {
      notify(`恢复失败：${e}`, "err");
    }
  };

  const deleteBackup = async (database: string, file: BackupFile) => {
    if (
      useStore.getState().ws.settings.confirmDestructive &&
      !(await confirmDialog({ title: "删除备份", message: `确定删除备份文件 ${file.name}？` }))
    ) {
      return;
    }
    try {
      await api.backupDelete(file.path);
      notify("已删除备份", "ok");
      await loadBackups(database);
    } catch (e) {
      notify(`删除失败：${e}`, "err");
    }
  };

  const openBackupDir = async () => {
    try {
      const dir = await api.backupDir(conn.id);
      await revealItemInDir(`${dir}/`).catch(() => void 0);
    } catch (e) {
      notify(`打开备份目录失败：${e}`, "err");
    }
  };

  // ---------- 右键菜单 ----------

  const dbMenu = (database: string): MenuItemSpec[] => [
    {
      label: expanded[database] ? "收起" : "展开",
      icon: <ChevronRight size={13} />,
      onClick: () => void toggleDb(database),
    },
    {
      label: "刷新",
      icon: <RefreshCw size={13} />,
      onClick: () => {
        void loadTables(database, true);
        void loadRoutines(database, true);
        void loadBackups(database);
      },
    },
    { separator: true, label: "s1" },
    { label: "新建查询", icon: <TerminalSquare size={13} />, onClick: () => onOpenQuery(database, "") },
    {
      label: "运行 SQL 语句…",
      icon: <Play size={13} />,
      onClick: () => onOpenQuery(database, ""),
    },
    { label: "运行 SQL 文件…", icon: <FileCode2 size={13} />, onClick: () => void runSqlFile(database) },
    { separator: true, label: "s2" },
    {
      label: "导入 SQL 脚本…",
      icon: <Upload size={13} />,
      onClick: () => onImport(database),
    },
    {
      label: "导出数据库（仅结构）",
      icon: <Download size={13} />,
      onClick: () => void exportDatabase(database, "structure"),
    },
    {
      label: "导出数据库（结构 + 数据）",
      icon: <Download size={13} />,
      onClick: () => void exportDatabase(database, "data"),
    },
    { separator: true, label: "s3" },
    { label: "新建备份", icon: <Archive size={13} />, onClick: () => void createBackup(database) },
    { label: "打开备份目录", icon: <FolderOpen size={13} />, onClick: () => void openBackupDir() },
  ];

  const tableMenu = (database: string, t: TableInfo): MenuItemSpec[] => [
    { label: "打开数据（新标签页）", icon: <Table2 size={13} />, onClick: () => onOpenTable(database, t.name) },
    {
      label: "生成 SELECT 语句",
      icon: <TerminalSquare size={13} />,
      onClick: () => onOpenQuery(database, `SELECT * FROM \`${t.name}\` LIMIT 100;`),
    },
    { separator: true, label: "s1" },
    { label: "导入数据到该表", icon: <Upload size={13} />, onClick: () => onImport(database, t.name) },
  ];

  const queryMenu = (database: string, q: { id: string; name: string; sql: string }): MenuItemSpec[] => [
    { label: "打开查询", icon: <TerminalSquare size={13} />, onClick: () => onOpenQuery(database, q.sql) },
    {
      label: "删除查询",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => {
        void (async () => {
          if (
            useStore.getState().ws.settings.confirmDestructive &&
            !(await confirmDialog({ title: "删除查询", message: `确定删除保存的查询「${q.name}」？` }))
          ) {
            return;
          }
          removeSavedQuery(q.id);
          notify("已删除查询", "ok");
        })();
      },
    },
  ];

  const backupMenu = (database: string, file: BackupFile): MenuItemSpec[] => [
    { label: "恢复此备份", icon: <RefreshCw size={13} />, onClick: () => void restoreBackup(database, file) },
    { label: "删除备份", icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteBackup(database, file) },
    { separator: true, label: "s1" },
    {
      label: "打开所在目录",
      icon: <FolderOpen size={13} />,
      onClick: () => void revealItemInDir(file.path).catch(() => void 0),
    },
  ];

  const openMenuAt = (e: React.MouseEvent, items: MenuItemSpec[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (!isConnected) {
    return (
      <div className="sb-children">
        <div className="obj-empty">连接后可展开查看数据库与表</div>
      </div>
    );
  }

  const sectionHead = (database: string, key: SectionKey, label: string, icon: React.ReactNode, count: number) => {
    const k = `${database}:${key}`;
    const open = Boolean(sections[k]);
    return (
      <div className="sb-section" onClick={() => void toggleSection(database, key)} title={`${label}（${count}）`}>
        <span className={`obj-chev ${open ? "open" : ""}`} style={{ width: "0.8rem" }}>
          <ChevronRight size={11} />
        </span>
        <span className="obj-ico">{icon}</span>
        <span className="tree-label">{label}</span>
        <span className="obj-count">{count}</span>
      </div>
    );
  };

  return (
    <div className="sb-children">
      {loading && <div className="obj-empty">加载中…</div>}
      {error && <div className="obj-empty" style={{ color: "var(--danger)" }}>{error}</div>}

      {dbs.map((db) => {
        const isOpen = Boolean(expanded[db]);
        const all = tables[db] ?? [];
        const tableList = all.filter((t) => t.kind === "table");
        const viewList = all.filter((t) => t.kind === "view");
        const routineList = routines[db] ?? [];
        const myQueries = savedQueries.filter((q) => q.connId === conn.id && q.database === db);
        const backupList = backups[db] ?? [];
        return (
          <div key={db}>
            <div
              className={`sb-db ${sel?.kind === "db" && sel.db === db ? "active" : ""}`}
              onClick={() => setSel({ kind: "db", db })}
              onDoubleClick={() => void toggleDb(db)}
              onContextMenu={(e) => openMenuAt(e, dbMenu(db))}
              title={`${db}（双击展开/收起，右键更多操作）`}
            >
              <button
                className={`obj-chev ${isOpen ? "open" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleDb(db);
                }}
                title={isOpen ? "收起" : "展开"}
              >
                <ChevronRight size={12} />
              </button>
              <span className="obj-ico">
                <Database size={12} color="var(--accent)" />
              </span>
              <span className="tree-label">{db}</span>
              <span className="obj-count">
                {loadingDb[db] ? "…" : all.length ? all.length : ""}
              </span>
            </div>

            {isOpen && (
              <div className="sb-children">
                {/* 表 */}
                {sectionHead(db, "tables", "表", <Table2 size={11} color="var(--text-3)" />, tableList.length)}
                {sections[`${db}:tables`] && (
                  <div className="sb-children">
                    {tableList.map((t) => {
                      const active = sel?.kind === "table" && sel.db === db && sel.table === t.name;
                      return (
                        <div
                          key={t.name}
                          className={`sb-table ${active ? "active" : ""}`}
                          onClick={() => setSel({ kind: "table", db, table: t.name })}
                          onDoubleClick={() => onOpenTable(db, t.name)}
                          onContextMenu={(e) => {
                            setSel({ kind: "table", db, table: t.name });
                            openMenuAt(e, tableMenu(db, t));
                          }}
                          title={`${t.name}（双击打开数据）`}
                        >
                          <span className="obj-spacer" />
                          <span className="obj-ico">
                            <Table2 size={11} color="var(--text-3)" />
                          </span>
                          <span className="tree-label">{t.name}</span>
                        </div>
                      );
                    })}
                    {!tableList.length && !loadingDb[db] && <div className="obj-empty">无表</div>}
                  </div>
                )}

                {/* 视图 */}
                {sectionHead(db, "views", "视图", <Eye size={11} color="var(--info)" />, viewList.length)}
                {sections[`${db}:views`] && (
                  <div className="sb-children">
                    {viewList.map((t) => (
                      <div
                        key={t.name}
                        className={`sb-table ${
                          sel?.kind === "table" && sel.db === db && sel.table === t.name ? "active" : ""
                        }`}
                        onClick={() => setSel({ kind: "table", db, table: t.name })}
                        onDoubleClick={() => onOpenTable(db, t.name)}
                        onContextMenu={(e) => {
                          setSel({ kind: "table", db, table: t.name });
                          openMenuAt(e, tableMenu(db, t));
                        }}
                        title={`${t.name}（视图，双击查看数据）`}
                      >
                        <span className="obj-spacer" />
                        <span className="obj-ico">
                          <Eye size={11} color="var(--info)" />
                        </span>
                        <span className="tree-label">{t.name}</span>
                      </div>
                    ))}
                    {!viewList.length && <div className="obj-empty">无视图</div>}
                  </div>
                )}

                {/* 函数 */}
                {sectionHead(db, "routines", "函数", <FunctionSquare size={11} color="var(--warn)" />, routineList.length)}
                {sections[`${db}:routines`] && (
                  <div className="sb-children">
                    {routineList.map((r) => (
                      <div
                        key={`${r.kind}-${r.name}`}
                        className="sb-table"
                        onDoubleClick={() =>
                          onOpenQuery(
                            db,
                            `SHOW CREATE ${r.kind === "PROCEDURE" ? "PROCEDURE" : "FUNCTION"} \`${r.name}\`;`,
                          )
                        }
                        title={`${r.name}（${r.kind}${r.returns ? ` → ${r.returns}` : ""}，双击查看定义）`}
                      >
                        <span className="obj-spacer" />
                        <span className="obj-ico">
                          <FunctionSquare size={11} color="var(--warn)" />
                        </span>
                        <span className="tree-label">{r.name}</span>
                      </div>
                    ))}
                    {!routineList.length && (
                      <div className="obj-empty">
                        {conn.kind === "sqlite" ? "SQLite 无存储函数" : "无函数 / 存储过程"}
                      </div>
                    )}
                  </div>
                )}

                {/* 查询（保存的 SQL） */}
                {sectionHead(db, "queries", "查询", <TerminalSquare size={11} color="var(--success)" />, myQueries.length)}
                {sections[`${db}:queries`] && (
                  <div className="sb-children">
                    {myQueries.map((q) => (
                      <div
                        key={q.id}
                        className={`sb-table ${sel?.kind === "query" && sel.id === q.id ? "active" : ""}`}
                        onClick={() => setSel({ kind: "query", db, id: q.id })}
                        onDoubleClick={() => onOpenQuery(db, q.sql)}
                        onContextMenu={(e) => {
                          setSel({ kind: "query", db, id: q.id });
                          openMenuAt(e, queryMenu(db, q));
                        }}
                        title={`${q.name}（双击打开）`}
                      >
                        <span className="obj-spacer" />
                        <span className="obj-ico">
                          <TerminalSquare size={11} color="var(--success)" />
                        </span>
                        <span className="tree-label">{q.name}</span>
                      </div>
                    ))}
                    <div
                      className="sb-table sb-action"
                      onClick={() => {
                        onOpenQuery(db, "");
                        notify("在查询窗口点『保存查询』即可收藏到这里", "info");
                      }}
                      title="新建查询"
                    >
                      <span className="obj-spacer" />
                      <span className="obj-ico">
                        <Plus size={11} color="var(--text-3)" />
                      </span>
                      <span className="tree-label">新建查询…</span>
                    </div>
                  </div>
                )}

                {/* 备份 */}
                {sectionHead(db, "backups", "备份", <Archive size={11} color="var(--text-3)" />, backupList.length)}
                {sections[`${db}:backups`] && (
                  <div className="sb-children">
                    {backupList.map((f) => (
                      <div
                        key={f.path}
                        className={`sb-table ${sel?.kind === "backup" && sel.path === f.path ? "active" : ""}`}
                        onClick={() => setSel({ kind: "backup", db, path: f.path })}
                        onDoubleClick={() => void restoreBackup(db, f)}
                        onContextMenu={(e) => {
                          setSel({ kind: "backup", db, path: f.path });
                          openMenuAt(e, backupMenu(db, f));
                        }}
                        title={`${f.name} · ${(f.size / 1024).toFixed(1)} KB（双击恢复）`}
                      >
                        <span className="obj-spacer" />
                        <span className="obj-ico">
                          <Save size={11} color="var(--text-3)" />
                        </span>
                        <span className="tree-label">{f.name}</span>
                      </div>
                    ))}
                    <div
                      className="sb-table sb-action"
                      onClick={() => void createBackup(db)}
                      title="立即备份整个数据库"
                    >
                      <span className="obj-spacer" />
                      <span className="obj-ico">
                        {busyKey === `${db}:backup` ? (
                          <div className="spinner" style={{ width: "0.7rem", height: "0.7rem" }} />
                        ) : (
                          <Plus size={11} color="var(--text-3)" />
                        )}
                      </span>
                      <span className="tree-label">立即备份…</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {!loading && !error && !dbs.length && <div className="obj-empty">没有可用的数据库</div>}

      <div className="sb-tree-foot">
        <span>{dbs.length} 库</span>
        <button className="icon-btn" title="刷新" onClick={refresh} style={{ width: "1.4rem", height: "1.4rem" }}>
          <RefreshCw size={11} />
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
