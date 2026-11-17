import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Database,
  Eye,
  RefreshCw,
  Table2,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { cacheKey, dbCache, invalidateConnCache, tableCache } from "../explorerCache";
import type { Connection, TableInfo } from "../types";
import { ContextMenu, type MenuItemSpec } from "./ui";
import { connectTo } from "../actions";

export { invalidateConnCache };

interface Props {
  conn: Connection;
  onOpenTable: (database: string, table: string) => void;
  onOpenQuery: (database: string, sql?: string) => void;
  onImport: (database: string, table?: string) => void;
}

type Selection = { kind: "db"; db: string } | { kind: "table"; db: string; table: string } | null;

/** 左侧栏里连接节点下的「数据库 → 表」树（Navicat 风格） */
export function ConnectionExplorer({ conn, onOpenTable, onOpenQuery, onImport }: Props) {
  const notify = useStore((s) => s.notify);
  const isConnected = Boolean(useStore((s) => s.connected[conn.id]));

  const [dbs, setDbs] = useState<string[]>(() => dbCache.get(conn.id) ?? []);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [loadingDb, setLoadingDb] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItemSpec[] } | null>(null);

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

  /** 展开数据库：未连接时先连接 */
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
    void loadDatabases(true);
  };

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

  const dbMenu = (database: string): MenuItemSpec[] => [
    {
      label: expanded[database] ? "收起" : "展开",
      icon: <ChevronRight size={13} />,
      onClick: () => void toggleDb(database),
    },
    { label: "刷新表", icon: <RefreshCw size={13} />, onClick: () => void loadTables(database, true) },
    { label: "新建查询", icon: <TerminalSquare size={13} />, onClick: () => onOpenQuery(database, "") },
    { label: "导入 SQL 脚本", icon: <Upload size={13} />, onClick: () => onImport(database) },
  ];

  const total = useMemo(() => Object.values(tables).reduce((n, l) => n + l.length, 0), [tables]);

  if (!isConnected) {
    return (
      <div className="sb-children">
        <div className="obj-empty">连接后可展开查看数据库与表</div>
      </div>
    );
  }

  return (
    <div className="sb-children">
      {loading && <div className="obj-empty">加载中…</div>}
      {error && <div className="obj-empty" style={{ color: "var(--danger)" }}>{error}</div>}
      {dbs.map((db) => {
        const isOpen = Boolean(expanded[db]);
        const list = tables[db] ?? [];
        return (
          <div key={db}>
            <div
              className={`sb-db ${sel?.kind === "db" && sel.db === db ? "active" : ""}`}
              onClick={() => setSel({ kind: "db", db })}
              onDoubleClick={() => void toggleDb(db)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: dbMenu(db) });
              }}
              title={`${db}（双击展开 / 收起）`}
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
              <span className="obj-count">{loadingDb[db] ? "…" : tables[db] ? tables[db].length : ""}</span>
            </div>

            {isOpen && (
              <div className="sb-children">
                {list.map((t) => {
                  const active = sel?.kind === "table" && sel.db === db && sel.table === t.name;
                  return (
                    <div
                      key={t.name}
                      className={`sb-table ${active ? "active" : ""}`}
                      onClick={() => setSel({ kind: "table", db, table: t.name })}
                      onDoubleClick={() => onOpenTable(db, t.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSel({ kind: "table", db, table: t.name });
                        setMenu({ x: e.clientX, y: e.clientY, items: tableMenu(db, t) });
                      }}
                      title={`${t.name}${t.kind === "view" ? "（视图）" : ""}（双击打开数据）`}
                    >
                      <span className="obj-spacer" />
                      <span className="obj-ico">
                        {t.kind === "view" ? (
                          <Eye size={12} color="var(--info)" />
                        ) : (
                          <Table2 size={12} color="var(--text-3)" />
                        )}
                      </span>
                      <span className="tree-label">{t.name}</span>
                    </div>
                  );
                })}
                {!list.length && !loadingDb[db] && <div className="obj-empty">无表</div>}
              </div>
            )}
          </div>
        );
      })}
      {!loading && !error && !dbs.length && <div className="obj-empty">没有可用的数据库</div>}
      <div className="sb-tree-foot">
        <span>
          {dbs.length} 库 / {total} 表
        </span>
        <button className="icon-btn" title="刷新" onClick={refresh} style={{ width: "1.4rem", height: "1.4rem" }}>
          <RefreshCw size={11} />
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
