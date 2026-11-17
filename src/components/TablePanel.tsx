import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Hash,
  ListOrdered,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  Undo2,
  Upload,
  Code2,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Cell, ColumnInfo, Connection, IndexInfo, RowsPage } from "../types";
import { DataGrid } from "./DataGrid";
import { DataEmpty, Spinner } from "./panelBits";
import { confirmDialog } from "./confirm";

type SubTab = "data" | "structure" | "indexes" | "ddl";

interface Props {
  conn: Connection;
  database: string;
  table: string;
  onExport: () => void;
  onImport: () => void;
  defaultTab?: SubTab;
}

export function TablePanel({ conn, database, table, onExport, onImport, defaultTab = "data" }: Props) {
  const notify = useStore((s) => s.notify);
  const pageSizeSetting = useStore((s) => s.ws.settings.pageSize);

  const [tab, setTab] = useState<SubTab>(defaultTab);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [ddl, setDdl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(pageSizeSetting || 500);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [where, setWhere] = useState("");
  const [whereApplied, setWhereApplied] = useState("");
  const [showWhere, setShowWhere] = useState(false);
  const [edits, setEdits] = useState<Record<string, Record<string, Cell>>>({});
  const [saving, setSaving] = useState(false);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  const orderBy = sort
    ? `${quote(sort.column)} ${sort.desc ? "DESC" : "ASC"}`
    : page?.primaryKey?.length
      ? page.primaryKey.map(quote).join(", ")
      : null;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fetchRows(
        conn.id,
        database,
        table,
        limit,
        offset,
        whereApplied || null,
        orderBy,
      );
      setPage(res);
    } catch (e) {
      setError(String(e));
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [conn.id, database, table, limit, offset, whereApplied, orderBy]);

  const loadMeta = useCallback(async () => {
    try {
      const [cols, idx] = await Promise.all([
        api.columns(conn.id, database, table),
        api.indexes(conn.id, database, table).catch(() => []),
      ]);
      setColumns(cols);
      setIndexes(idx);
    } catch (e) {
      notify(`读取表结构失败：${e}`, "err");
    }
  }, [conn.id, database, table, notify]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadMeta();
    setEdits({});
    setOffset(0);
    setSort(null);
    setDdl("");
    setTab(defaultTab);
  }, [conn.id, database, table]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "ddl" || ddl) return;
    api
      .ddl(conn.id, database, table)
      .then(setDdl)
      .catch((e) => setDdl(`-- 读取失败：${e}`));
  }, [tab, ddl, conn.id, database, table]);

  const gridColumns = useMemo(() => {
    if (!page) return [];
    const map = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
    return page.columns.map((c) => ({
      name: c.name,
      dataType: map.get(c.name.toLowerCase())?.dataType ?? c.dataType ?? "",
    }));
  }, [page, columns]);

  const dirtyKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [rowIdx, cols] of Object.entries(edits)) {
      for (const col of Object.keys(cols)) set.add(`${rowIdx}:${col}`);
    }
    return set;
  }, [edits]);

  const hasPk = Boolean(page?.primaryKey?.length);
  const dirtyCount = Object.values(edits).reduce((n, cols) => n + Object.keys(cols).length, 0);

  const onCommit = (rowIndex: number, column: string, value: Cell) => {
    setEdits((prev) => {
      const next = { ...prev, [rowIndex]: { ...(prev[rowIndex] ?? {}), [column]: value } };
      return next;
    });
  };

  const saveChanges = async () => {
    if (!page) return;
    if (!hasPk) {
      notify("该表没有主键，无法安全地保存修改", "err");
      return;
    }
    setSaving(true);
    try {
      const changes = Object.entries(edits).map(([rowIdx, cols]) => {
        const row = page.rows[Number(rowIdx)];
        const pk = page.primaryKey.map((pkName) => {
          const idx = page.columns.findIndex((c) => c.name === pkName);
          return { column: pkName, value: idx >= 0 ? (row[idx] ?? null) : null };
        });
        return {
          action: "update" as const,
          pk,
          values: Object.entries(cols).map(([col, v]) => ({ column: col, value: v })),
        };
      });
      const res = await api.applyChanges(conn.id, database, table, changes);
      if (res.errors.length) {
        notify(`部分更改失败：${res.errors[0]}`, "err");
      } else {
        notify(`已保存 ${res.applied} 处修改`, "ok");
        setEdits({});
      }
      await loadData();
    } catch (e) {
      notify(`保存失败：${e}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const total = page?.total ?? 0;
  const pageNo = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));

  const insertRow = async () => {
    try {
      const id = await api.insertDefaultRow(conn.id, database, table);
      notify(id > 0 ? `已插入一行（主键 ${id}）` : "已插入一行", "ok");
      await loadData();
    } catch (e) {
      notify(`插入失败：${e}`, "err");
    }
  };

  const deleteRow = async () => {
    if (!page || selectedRow == null) return;
    if (!hasPk) {
      notify("该表没有主键，无法定位要删除的行", "err");
      return;
    }
    const row = page.rows[selectedRow];
    const pkDesc = page.primaryKey
      .map((name) => {
        const idx = page.columns.findIndex((c) => c.name === name);
        return `${name}=${row[idx] ?? "NULL"}`;
      })
      .join(", ");
    if (
      useStore.getState().ws.settings.confirmDestructive &&
      !(await confirmDialog({ title: "删除行", message: `确定删除这一行？(${pkDesc})` }))
    ) {
      return;
    }
    try {
      const pk = page.primaryKey.map((name) => {
        const idx = page.columns.findIndex((c) => c.name === name);
        return { column: name, value: idx >= 0 ? (row[idx] ?? null) : null };
      });
      const res = await api.applyChanges(conn.id, database, table, [
        { action: "delete", pk, values: [] },
      ]);
      if (res.errors.length) notify(`删除失败：${res.errors[0]}`, "err");
      else notify("已删除 1 行", "ok");
      setSelectedRow(null);
      await loadData();
    } catch (e) {
      notify(`删除失败：${e}`, "err");
    }
  };

  return (
    <>
      <div className="subtabbar">
        <button className={`subtab ${tab === "data" ? "active" : ""}`} onClick={() => setTab("data")}>
          <Table2 size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          数据
        </button>
        <button
          className={`subtab ${tab === "structure" ? "active" : ""}`}
          onClick={() => setTab("structure")}
        >
          <ListOrdered size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          结构
        </button>
        <button className={`subtab ${tab === "indexes" ? "active" : ""}`} onClick={() => setTab("indexes")}>
          <Hash size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          索引 {indexes.length ? `(${indexes.length})` : ""}
        </button>
        <button className={`subtab ${tab === "ddl" ? "active" : ""}`} onClick={() => setTab("ddl")}>
          <Code2 size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          DDL
        </button>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.3rem" }}>
          <button className="btn sm" onClick={onImport} title="从文件导入数据">
            <Upload size={13} /> 导入
          </button>
          <button className="btn sm" onClick={onExport} title="导出表数据">
            <Download size={13} /> 导出
          </button>
        </div>
      </div>

      <div className="content-body">
        {tab === "data" && (
          <>
            <div className="grid-toolbar">
              <button className="btn sm ghost" onClick={() => void loadData()} title="刷新">
                <RefreshCw size={13} />
              </button>
              <button
                className={`btn sm ghost ${showWhere ? "active" : ""}`}
                onClick={() => setShowWhere((v) => !v)}
                title="筛选条件"
              >
                <Filter size={13} /> 筛选
              </button>
              <button className="btn sm ghost" onClick={() => void insertRow()} title="插入一行默认值记录">
                <Plus size={13} /> 新增行
              </button>
              <button
                className="btn sm ghost"
                onClick={() => void deleteRow()}
                disabled={selectedRow == null || !hasPk}
                title={hasPk ? "删除选中的行" : "无主键，无法删除"}
              >
                <Trash2 size={13} /> 删除行
              </button>
              {showWhere && (
                <input
                  className="input"
                  style={{ width: "18rem", height: "1.6rem", fontSize: "0.88rem" }}
                  placeholder="例如：status = 1 AND created_at > '2024-01-01'"
                  value={where}
                  onChange={(e) => setWhere(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setOffset(0);
                      setWhereApplied(where);
                    }
                  }}
                />
              )}
              <button
                className="btn sm"
                disabled={!hasPk || !dirtyCount || saving}
                onClick={() => void saveChanges()}
                title={hasPk ? "保存单元格修改" : "无主键，无法保存修改"}
              >
                <Save size={13} /> 保存{dirtyCount ? `（${dirtyCount}）` : ""}
              </button>
              <button
                className="btn sm ghost"
                disabled={!dirtyCount}
                onClick={() => setEdits({})}
                title="撤销未保存的修改"
              >
                <Undo2 size={13} /> 撤销
              </button>
              <span className="grow" />
              <span className="toolbar-hint">
                {hasPk ? `主键：${page?.primaryKey.join(", ")}` : "无主键（只读编辑）"}
              </span>
            </div>

            {error ? (
              <div className="msg-line err">{error}</div>
            ) : loading ? (
              <Spinner label="读取数据…" />
            ) : page ? (
              <DataGrid
                columns={gridColumns}
                rows={page.rows}
                primaryKey={page.primaryKey}
                editable={hasPk}
                dirty={dirtyKeys}
                sortBy={sort}
                selectedRow={selectedRow}
                onSelectRow={setSelectedRow}
                onSort={(col) => {
                  setSort((s) =>
                    s?.column === col ? { column: col, desc: !s.desc } : { column: col, desc: false },
                  );
                  setOffset(0);
                }}
                onCommit={onCommit}
                emptyText="该表暂无数据，或筛选条件没有匹配的行。"
              />
            ) : (
              <DataEmpty />
            )}

            <div className="pager">
              <button
                className="icon-btn"
                disabled={offset <= 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                title="上一页"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                className="icon-btn"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                title="下一页"
              >
                <ChevronRight size={14} />
              </button>
              <span>
                第 {pageNo} / {pageCount} 页 · 共 {total} 行
              </span>
              <span className="grow" />
              <span>每页</span>
              <select
                className="input"
                style={{ width: "5rem", height: "1.5rem", fontSize: "0.85rem" }}
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setOffset(0);
                }}
              >
                {[100, 200, 500, 1000, 5000].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {page && <span>{page.durationMs}ms</span>}
            </div>
          </>
        )}

        {tab === "structure" && (
          <div className="grid-wrap" style={{ padding: 0 }}>
            <table className="meta-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>列名</th>
                  <th>类型</th>
                  <th>可空</th>
                  <th>键</th>
                  <th>默认值</th>
                  <th>额外</th>
                  <th>注释</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={c.name}>
                    <td>{i + 1}</td>
                    <td className="mono">{c.name}</td>
                    <td className="mono">{c.dataType || "—"}</td>
                    <td>{c.nullable ? "是" : "否"}</td>
                    <td>{c.key || ""}</td>
                    <td className="mono">{c.defaultValue ?? "—"}</td>
                    <td>{c.extra || ""}</td>
                    <td style={{ color: "var(--text-3)" }}>{c.comment ?? ""}</td>
                  </tr>
                ))}
                {!columns.length && (
                  <tr>
                    <td colSpan={8} style={{ padding: "0.8rem", color: "var(--text-3)" }}>
                      无列信息
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "indexes" && (
          <div className="grid-wrap">
            <table className="meta-table">
              <thead>
                <tr>
                  <th>索引名</th>
                  <th>列</th>
                  <th>唯一</th>
                  <th>主键</th>
                </tr>
              </thead>
              <tbody>
                {indexes.map((ix) => (
                  <tr key={ix.name}>
                    <td className="mono">{ix.name}</td>
                    <td className="mono">{ix.columns.join(", ")}</td>
                    <td>{ix.unique ? "是" : "否"}</td>
                    <td>{ix.primary ? "是" : ""}</td>
                  </tr>
                ))}
                {!indexes.length && (
                  <tr>
                    <td colSpan={4} style={{ padding: "0.8rem", color: "var(--text-3)" }}>
                      无索引
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "ddl" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0.6rem", minHeight: 0 }}>
            <pre className="code-block">{ddl || "-- 加载中…"}</pre>
          </div>
        )}
      </div>
    </>
  );
}

function quote(name: string) {
  return `\`${name.replace(/`/g, "``")}\``;
}
