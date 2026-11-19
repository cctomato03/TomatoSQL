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
  Download,
  Power,
} from "lucide-react";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { cacheKey, dbCache, invalidateConnCache, tableCache } from "../explorerCache";
import { useStore } from "../store";
import type { BackupFile, Connection, RoutineInfo, TableInfo } from "../types";
import { ContextMenu, type MenuItemSpec } from "./ui";
import { confirmDialog } from "./confirm";
import { connectTo, disconnectFrom } from "../actions";
import {
  SqlScriptDialog,
  functionTemplate,
  tableTemplate,
  viewTemplate,
} from "./SqlScriptDialog";

export { invalidateConnCache };

interface Props {
  conn: Connection;
  onOpenTable: (database: string, table: string) => void;
  onOpenQuery: (database: string, sql?: string) => void;
}

type Sections = "tables" | "views" | "routines" | "queries" | "backups";

type ScriptDialog = {
  database: string;
  title: string;
  hint?: string;
  sql: string;
} | null;

/** 左侧栏里连接节点下的对象树：数据库 → 表 / 视图 / 函数 / 查询 / 备份 */
export function ConnectionExplorer({ conn, onOpenTable, onOpenQuery }: Props) {
  const notify = useStore((s) => s.notify);
  const savedQueries = useStore((s) => s.ws.savedQueries ?? []);
  const removeSavedQuery = useStore((s) => s.removeSavedQuery);
  const isConnected = Boolean(useStore((s) => s.connected[conn.id]));

  const [dbs, setDbs] = useState<string[]>(() => dbCache.get(conn.id) ?? []);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [routines, setRoutines] = useState<Record<string, RoutineInfo[]>>({});
  const [backups, setBackups] = useState<Record<string, BackupFile[]>>({});
  const [loadingDb, setLoadingDb] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItemSpec[] } | null>(null);
  const [scriptDialog, setScriptDialog] = useState<ScriptDialog>(null);
  /** 当前选中项：单击只做选中，双击才打开 */
  const [sel, setSel] = useState<
    | { kind: "db"; db: string }
    | { kind: "table"; db: string; name: string }
    | { kind: "query"; db: string; id: string }
    | { kind: "backup"; db: string; path: string }
    | null
  >(null);

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
    async (database: string) => {
      try {
        setRoutines((s) => ({ ...s, [database]: s[database] ?? [] }));
        const list = await api.routines(conn.id, database);
        setRoutines((s) => ({ ...s, [database]: list }));
      } catch (e) {
        notify(`读取函数列表失败：${e}`, "err");
        setRoutines((s) => ({ ...s, [database]: [] }));
      }
    },
    [conn.id, notify],
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

  /** 打开数据库：加载它的元数据（双击或右键「打开」） */
  const openDatabase = useCallback(
    async (database: string) => {
      if (!isConnected) {
        const ok = await connectTo(conn);
        if (!ok) return;
      }
      setOpened((s) => ({ ...s, [database]: true }));
      void loadTables(database);
    },
    [isConnected, conn, loadTables],
  );

  /** 关闭数据库：收起、释放元数据；若该连接已没有打开的库，则顺带断开连接 */
  const closeDatabase = useCallback(
    async (database: string) => {
      setOpened((s) => {
        const next = { ...s, [database]: false };
        const anyOpen = Object.entries(next).some(([k, v]) => v && k !== database);
        if (!anyOpen) {
          void disconnectFrom(conn.id).then(() =>
            notify(`已关闭数据库 ${database} 并断开连接`, "ok"),
          );
        } else {
          notify(`已关闭数据库 ${database}`, "ok");
        }
        return next;
      });
      // 清掉该库的元数据缓存，下次打开重新读取
      tableCache.delete(cacheKey(conn.id, database));
      setTables((s) => {
        const next = { ...s };
        delete next[database];
        return next;
      });
      setRoutines((s) => {
        const next = { ...s };
        delete next[database];
        return next;
      });
      setBackups((s) => {
        const next = { ...s };
        delete next[database];
        return next;
      });
      setSections((s) => {
        const next = { ...s };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${database}:`)) delete next[key];
        }
        return next;
      });
    },
    [conn.id, notify],
  );

  const refreshDatabase = async (database: string) => {
    tableCache.delete(cacheKey(conn.id, database));
    await Promise.all([loadTables(database, true), loadRoutines(database), loadBackups(database)]);
  };

  const refresh = () => {
    invalidateConnCache(conn.id);
    setTables({});
    setRoutines({});
    setBackups({});
    void loadDatabases(true);
  };

  const toggleSection = async (database: string, key: Sections) => {
    const k = `${database}:${key}`;
    const next = !sections[k];
    setSections((s) => ({ ...s, [k]: next }));
    if (!next) return;
    if (key === "routines") await loadRoutines(database);
    if (key === "backups") await loadBackups(database);
    if (key === "tables" || key === "views") await loadTables(database);
  };

  // ---------- 数据库级操作 ----------

  const exportDatabase = async (database: string, mode: "structure" | "data") => {
    try {
      const list = await api.tables(conn.id, database);
      const names = list.filter((t) => t.kind === "table").map((t) => t.name);
      if (!names.length) throw new Error("该数据库没有表可导出");
      const target = await saveFile({
        defaultPath: `${database || "database"}-${mode === "structure" ? "schema" : "full"}.sql`,
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
    }
  };

  const runSqlFile = async (database: string) => {
    const picked = await openFile({
      multiple: false,
      filters: [{ name: "SQL 脚本", extensions: ["sql"] }],
    });
    if (typeof picked !== "string") return;
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
      void refreshDatabase(database);
    } catch (e) {
      notify(`执行失败：${e}`, "err");
    }
  };

  const dropDatabase = async (database: string) => {
    if (
      !(await confirmDialog({
        title: "删除数据库",
        message: `确定删除数据库「${database}」？\n该操作会删除库中所有表与数据，不可撤销。`,
      }))
    ) {
      return;
    }
    try {
      await api.dropDatabase(conn.id, database);
      notify(`已删除数据库 ${database}`, "ok");
      refresh();
    } catch (e) {
      notify(`删除失败：${e}`, "err");
    }
  };

  const createBackup = async (database: string) => {
    try {
      const file = await api.backupCreate(conn.id, database);
      notify(`备份完成：${file.name}（${(file.size / 1024).toFixed(1)} KB）`, "ok");
      setSections((s) => ({ ...s, [`${database}:backups`]: true }));
      await loadBackups(database);
    } catch (e) {
      notify(`备份失败：${e}`, "err");
    }
  };

  const restoreBackup = async (database: string, file: BackupFile) => {
    if (
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
      await refreshDatabase(database);
    } catch (e) {
      notify(`恢复失败：${e}`, "err");
    }
  };

  const deleteBackup = async (database: string, file: BackupFile) => {
    if (
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

  // ---------- 右键菜单（按你的要求精简） ----------

  /** 数据库：打开/关闭、刷新、新建查询、运行 SQL 文件、导出（结构 / 结构+数据）、删除 */
  const dbMenu = (database: string): MenuItemSpec[] => {
    const isOpen = Boolean(opened[database]);
    return [
      isOpen
        ? { label: "关闭数据库", icon: <Power size={13} />, onClick: () => void closeDatabase(database) }
        : { label: "打开数据库", icon: <Power size={13} />, onClick: () => void openDatabase(database) },
      {
        label: "刷新",
        icon: <RefreshCw size={13} />,
        onClick: () => void refreshDatabase(database),
      },
      { separator: true, label: "s1" },
      {
        label: "新建查询",
        icon: <TerminalSquare size={13} />,
        onClick: () => onOpenQuery(database, ""),
      },
      {
        label: "运行 SQL 文件…",
        icon: <FileCode2 size={13} />,
        onClick: () => void runSqlFile(database),
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
      { separator: true, label: "s2" },
      {
        label: "删除数据库",
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => void dropDatabase(database),
      },
    ];
  };

  /** 表 / 视图 / 函数 / 查询 / 备份：只保留对应的「新建」 */
  const newOnlyMenu = (database: string, label: string, action: () => void): MenuItemSpec[] => [
    { label, icon: <Plus size={13} />, onClick: action },
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

  const sectionHead = (
    database: string,
    key: Sections,
    label: string,
    icon: React.ReactNode,
    count: number,
    onNew: () => void,
    newLabel: string,
  ) => {
    const k = `${database}:${key}`;
    const open = Boolean(sections[k]);
    return (
      <div
        className="sb-section"
        onClick={() => void toggleSection(database, key)}
        onContextMenu={(e) => openMenuAt(e, newOnlyMenu(database, newLabel, onNew))}
        title={`${label}（${count}）`}
      >
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
        const isOpen = Boolean(opened[db]);
        const all = tables[db] ?? [];
        const tableList = all.filter((t) => t.kind === "table");
        const viewList = all.filter((t) => t.kind === "view");
        const routineList = routines[db] ?? [];
        const myQueries = savedQueries.filter((q) => q.connId === conn.id && q.database === db);
        const backupList = backups[db] ?? [];
        return (
          <div key={db}>
            <div
              className={`sb-db ${isOpen ? "opened" : ""} ${
                sel?.kind === "db" && sel.db === db ? "active" : ""
              }`}
              onClick={() => setSel({ kind: "db", db })}
              onDoubleClick={() => void (isOpen ? closeDatabase(db) : openDatabase(db))}
              onContextMenu={(e) => openMenuAt(e, dbMenu(db))}
              title={`${db}（单击选中，双击打开/关闭，右键更多操作）`}
            >
              <span className={`obj-chev ${isOpen ? "open" : ""}`} style={{ width: "0.8rem" }}>
                <ChevronRight size={12} />
              </span>
              <span className="obj-ico">
                <Database size={12} color={isOpen ? "var(--accent)" : "var(--text-3)"} />
              </span>
              <span className="tree-label">{db}</span>
              <span className="obj-count">
                {loadingDb[db] ? "…" : all.length ? all.length : ""}
              </span>
            </div>

            {isOpen && (
              <div className="sb-children">
                {sectionHead(db, "tables", "表", <Table2 size={11} color="var(--text-3)" />, tableList.length,
                  () => setScriptDialog({ database: db, title: "新建表", hint: "按需修改建表语句后执行", sql: tableTemplate("new_table") }),
                  "新建表")}
                {sections[`${db}:tables`] && (
                  <div className="sb-children">
                    {tableList.map((t) => (
                      <div
                        key={t.name}
                        className={`sb-table ${sel?.kind === "table" && sel.db === db && sel.name === t.name ? "active" : ""}`}
                        onClick={() => setSel({ kind: "table", db, name: t.name })}
                        onDoubleClick={() => onOpenTable(db, t.name)}
                        onContextMenu={(e) =>
                          openMenuAt(e, newOnlyMenu(db, "新建表", () =>
                            setScriptDialog({ database: db, title: "新建表", sql: tableTemplate("new_table") }),
                          ))
                        }
                        title={`${t.name}（双击打开数据）`}
                      >
                        <span className="obj-ico">
                          <Table2 size={11} color="var(--text-3)" />
                        </span>
                        <span className="tree-label">{t.name}</span>
                      </div>
                    ))}
                    {!tableList.length && !loadingDb[db] && <div className="obj-empty">无表</div>}
                  </div>
                )}

                {sectionHead(db, "views", "视图", <Eye size={11} color="var(--info)" />, viewList.length,
                  () => setScriptDialog({ database: db, title: "新建视图", hint: "把 FROM 后面的表名改成你的表", sql: viewTemplate("new_view", db) }),
                  "新建视图")}
                {sections[`${db}:views`] && (
                  <div className="sb-children">
                    {viewList.map((t) => (
                      <div
                        key={t.name}
                        className={`sb-table ${sel?.kind === "table" && sel.db === db && sel.name === t.name ? "active" : ""}`}
                        onClick={() => setSel({ kind: "table", db, name: t.name })}
                        onDoubleClick={() => onOpenTable(db, t.name)}
                        onContextMenu={(e) =>
                          openMenuAt(e, newOnlyMenu(db, "新建视图", () =>
                            setScriptDialog({ database: db, title: "新建视图", sql: viewTemplate("new_view", db) }),
                          ))
                        }
                        title={`${t.name}（视图，双击查看数据）`}
                      >
                        <span className="obj-ico">
                          <Eye size={11} color="var(--info)" />
                        </span>
                        <span className="tree-label">{t.name}</span>
                      </div>
                    ))}
                    {!viewList.length && <div className="obj-empty">无视图</div>}
                  </div>
                )}

                {sectionHead(db, "routines", "函数", <FunctionSquare size={11} color="var(--warn)" />, routineList.length,
                  () => setScriptDialog({ database: db, title: "新建函数", hint: conn.kind === "sqlite" ? "SQLite 不支持存储函数，仅示例模板" : "MySQL 存储函数模板", sql: functionTemplate("new_fn") }),
                  "新建函数")}
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
                        onContextMenu={(e) =>
                          openMenuAt(e, newOnlyMenu(db, "新建函数", () =>
                            setScriptDialog({ database: db, title: "新建函数", sql: functionTemplate("new_fn") }),
                          ))
                        }
                        title={`${r.name}（${r.kind}，双击查看定义）`}
                      >
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

                {sectionHead(db, "queries", "查询", <TerminalSquare size={11} color="var(--success)" />, myQueries.length,
                  () => onOpenQuery(db, ""),
                  "新建查询")}
                {sections[`${db}:queries`] && (
                  <div className="sb-children">
                    {myQueries.map((q) => (
                      <div
                        key={q.id}
                        className={`sb-table ${sel?.kind === "query" && sel.id === q.id ? "active" : ""}`}
                        onClick={() => setSel({ kind: "query", db, id: q.id })}
                        onDoubleClick={() => onOpenQuery(db, q.sql)}
                        onContextMenu={(e) =>
                          openMenuAt(e, [
                            ...newOnlyMenu(db, "新建查询", () => onOpenQuery(db, "")),
                            { separator: true, label: "s1" },
                            {
                              label: "删除查询",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onClick: () => {
                                void (async () => {
                                  if (
                                    !(await confirmDialog({
                                      title: "删除查询",
                                      message: `确定删除保存的查询「${q.name}」？`,
                                    }))
                                  ) {
                                    return;
                                  }
                                  removeSavedQuery(q.id);
                                  notify("已删除查询", "ok");
                                })();
                              },
                            },
                          ])
                        }
                        title={`${q.name}（双击打开）`}
                      >
                        <span className="obj-ico">
                          <TerminalSquare size={11} color="var(--success)" />
                        </span>
                        <span className="tree-label">{q.name}</span>
                      </div>
                    ))}
                    {!myQueries.length && <div className="obj-empty">暂无保存的查询</div>}
                  </div>
                )}

                {sectionHead(db, "backups", "备份", <Archive size={11} color="var(--text-3)" />, backupList.length,
                  () => void createBackup(db),
                  "新建备份")}
                {sections[`${db}:backups`] && (
                  <div className="sb-children">
                    {backupList.map((f) => (
                      <div
                        key={f.path}
                        className={`sb-table ${sel?.kind === "backup" && sel.path === f.path ? "active" : ""}`}
                        onClick={() => setSel({ kind: "backup", db, path: f.path })}
                        onDoubleClick={() => void restoreBackup(db, f)}
                        onContextMenu={(e) =>
                          openMenuAt(e, [
                            ...newOnlyMenu(db, "新建备份", () => void createBackup(db)),
                            { separator: true, label: "s1" },
                            {
                              label: "恢复此备份",
                              icon: <RefreshCw size={13} />,
                              onClick: () => void restoreBackup(db, f),
                            },
                            {
                              label: "删除备份",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onClick: () => void deleteBackup(db, f),
                            },
                            {
                              label: "打开所在目录",
                              icon: <FolderOpen size={13} />,
                              onClick: () => void revealItemInDir(f.path).catch(() => void 0),
                            },
                          ])
                        }
                        title={`${f.name} · ${(f.size / 1024).toFixed(1)} KB（双击恢复）`}
                      >
                        <span className="obj-ico">
                          <Save size={11} color="var(--text-3)" />
                        </span>
                        <span className="tree-label">{f.name}</span>
                      </div>
                    ))}
                    {!backupList.length && <div className="obj-empty">暂无备份</div>}
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


      {scriptDialog && (
        <SqlScriptDialog
          conn={conn}
          database={scriptDialog.database}
          title={scriptDialog.title}
          hint={scriptDialog.hint}
          initialSql={scriptDialog.sql}
          onClose={() => setScriptDialog(null)}
          onDone={() => {
            // 执行完脚本（新建表/视图/函数）后，必须重新读取该库的对象列表，
            // 否则左栏会一直显示旧的表清单
            const db = scriptDialog.database;
            tableCache.delete(cacheKey(conn.id, db));
            void loadTables(db, true);
            void loadRoutines(db);
            void loadBackups(db);
          }}
        />
      )}
    </div>
  );
}
