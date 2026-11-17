import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Database,
  Eye,
  FileSearch,
  RefreshCw,
  Search,
  Table2,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Connection, TableInfo } from "../types";
import { ContextMenu, type MenuItemSpec } from "./ui";

interface Props {
  conn: Connection;
  onOpenTable: (database: string, table: string) => void;
  onOpenQuery: (database: string, sql?: string) => void;
  onImport: (database: string, table?: string) => void;
}

type Selection = { kind: "db"; db: string } | { kind: "table"; db: string; table: string } | null;

export function ObjectTree({ conn, onOpenTable, onOpenQuery, onImport }: Props) {
  const notify = useStore((s) => s.notify);
  const [dbs, setDbs] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [loadingDb, setLoadingDb] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItemSpec[] } | null>(null);

  const loadDatabases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.databases(conn.id);
      setDbs(list);
      // 不自动展开：由用户手动选择要看的数据库
      setExpanded({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [conn.id]);

  const loadTables = useCallback(
    async (database: string, force = false) => {
      if (!force && tables[database]) return;
      setLoadingDb((s) => ({ ...s, [database]: true }));
      try {
        const list = await api.tables(conn.id, database);
        setTables((s) => ({ ...s, [database]: list }));
      } catch (e) {
        notify(`读取表列表失败：${e}`, "err");
        setTables((s) => ({ ...s, [database]: [] }));
      } finally {
        setLoadingDb((s) => ({ ...s, [database]: false }));
      }
    },
    [conn.id, tables, notify],
  );

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  const toggleDb = useCallback(
    (database: string) => {
      setSel({ kind: "db", db: database });
      setExpanded((s) => {
        const next = !s[database];
        if (next) void loadTables(database);
        return { ...s, [database]: next };
      });
    },
    [loadTables],
  );

  const kw = filter.trim().toLowerCase();

  const tableMenu = (database: string, t: TableInfo): MenuItemSpec[] => [
    { label: "打开数据（新标签页）", icon: <Table2 size={13} />, onClick: () => onOpenTable(database, t.name) },
    {
      label: "生成 SELECT 语句",
      icon: <TerminalSquare size={13} />,
      onClick: () => onOpenQuery(database, `SELECT * FROM ${quote(t.name)} LIMIT 100;`),
    },
    { separator: true, label: "s1" },
    { label: "导入数据到该表", icon: <Upload size={13} />, onClick: () => onImport(database, t.name) },
  ];

  const dbMenu = (database: string): MenuItemSpec[] => [
    {
      label: expanded[database] ? "收起数据库" : "展开数据库",
      icon: <ChevronRight size={13} />,
      onClick: () => toggleDb(database),
    },
    { label: "刷新表", icon: <RefreshCw size={13} />, onClick: () => void loadTables(database, true) },
    {
      label: "新建查询",
      icon: <TerminalSquare size={13} />,
      onClick: () => onOpenQuery(database, ""),
    },
    { label: "导入 SQL 脚本", icon: <Upload size={13} />, onClick: () => onImport(database) },
  ];

  const totalTables = useMemo(
    () => Object.values(tables).reduce((n, list) => n + list.length, 0),
    [tables],
  );

  return (
    <div className="obj-panel">
      <div className="obj-panel-head">
        <span className="sidebar-title">{conn.kind === "mysql" ? "数据库" : "SQLite"}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.1rem" }}>
          <button
            className="icon-btn"
            title="新建查询"
            onClick={() => onOpenQuery(dbs[0] ?? "", "")}
            style={{ width: "1.6rem", height: "1.6rem" }}
          >
            <TerminalSquare size={14} />
          </button>
          <button
            className="icon-btn"
            title="刷新"
            onClick={() => {
              setTables({});
              setSel(null);
              void loadDatabases();
            }}
            style={{ width: "1.6rem", height: "1.6rem" }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div style={{ padding: "0.3rem 0.4rem" }}>
        <div style={{ position: "relative" }}>
          <Search
            size={12}
            style={{
              position: "absolute",
              left: "0.4rem",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-3)",
            }}
          />
          <input
            className="input"
            style={{ paddingLeft: "1.5rem", height: "1.6rem", fontSize: "0.88rem" }}
            placeholder="筛选表名"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="obj-list">
        {loading && <div style={{ padding: "0.5rem", color: "var(--text-3)" }}>加载中…</div>}
        {error && (
          <div style={{ padding: "0.5rem", color: "var(--danger)", fontSize: "0.85rem", lineHeight: 1.6 }}>
            {error}
          </div>
        )}
        {dbs.map((db) => {
          const isOpen = Boolean(expanded[db]);
          const list = (tables[db] ?? []).filter((t) => !kw || t.name.toLowerCase().includes(kw));
          const dbActive = sel?.kind === "db" && sel.db === db;
          return (
            <div className="obj-db" key={db}>
              <div
                className={`obj-db-head ${dbActive ? "active" : ""}`}
                onClick={() => setSel({ kind: "db", db })}
                onDoubleClick={() => toggleDb(db)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: dbMenu(db) });
                }}
                title={`${db}（双击展开/收起）`}
              >
                <button
                  className={`obj-chev ${isOpen ? "open" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleDb(db);
                  }}
                  title={isOpen ? "收起" : "展开"}
                >
                  <ChevronRight size={13} />
                </button>
                <span className="obj-ico">
                  <Database size={13} color="var(--accent)" />
                </span>
                <span className="tree-label">{db}</span>
                <span className="obj-count">
                  {loadingDb[db] ? "…" : tables[db] ? tables[db].length : ""}
                </span>
              </div>
              {isOpen && (
                <div>
                  {list.map((t) => {
                    const active =
                      sel?.kind === "table" && sel.db === db && sel.table === t.name;
                    return (
                      <div
                        key={t.name}
                        className={`obj-table ${active ? "active" : ""}`}
                        onClick={() => setSel({ kind: "table", db, table: t.name })}
                        onDoubleClick={() => onOpenTable(db, t.name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSel({ kind: "table", db, table: t.name });
                          setMenu({ x: e.clientX, y: e.clientY, items: tableMenu(db, t) });
                        }}
                        title={`${t.name}${t.kind === "view" ? "（视图）" : ""}（双击打开数据）`}
                      >
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
                  {!list.length && !loadingDb[db] && (
                    <div className="obj-empty">{tables[db] ? "无匹配的表" : "—"}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && !error && !dbs.length && (
          <div style={{ padding: "0.5rem", color: "var(--text-3)", fontSize: "0.85rem" }}>
            <FileSearch size={14} /> 没有可用的数据库
          </div>
        )}
      </div>

      <div className="pager" style={{ borderTop: "1px solid var(--border)", borderBottom: "none" }}>
        <span>
          {dbs.length} 库 / {totalTables} 表
        </span>
        <span className="grow" />
        <span style={{ fontSize: "0.78rem" }}>双击表打开</span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function quote(name: string) {
  return `\`${name.replace(/`/g, "``")}\``;
}
