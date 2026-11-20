import { useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ColumnInfo, Connection } from "../types";
import { Checkbox, Field, Modal } from "./ui";

interface NewColumn {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string;
}

const uid = () => `c-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

/**
 * 设计表：以现有列为基础，支持
 *  - 删除列（勾选）
 *  - 新增列（名字 / 类型 / 可空 / 默认值）
 *  - 修改已有列的类型与可空性（仅 MySQL；SQLite 会在执行时报错提示）
 * 保存时生成并执行 ALTER TABLE 语句。
 */
export function TableDesignDialog({
  conn,
  database,
  table,
  columns,
  onClose,
  onDone,
}: {
  conn: Connection;
  database: string;
  table: string;
  columns: ColumnInfo[];
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [drops, setDrops] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, { type: string; nullable: boolean }>>(() =>
    Object.fromEntries(columns.map((c) => [c.name, { type: c.dataType, nullable: c.nullable }])),
  );
  const [added, setAdded] = useState<NewColumn[]>([]);

  const isSqlite = conn.kind === "sqlite";

  const modified = useMemo(
    () =>
      columns
        .filter((c) => !drops[c.name])
        .filter((c) => {
          const e = edits[c.name];
          if (!e) return false;
          return e.type.trim() !== c.dataType.trim() || e.nullable !== c.nullable;
        })
        .map((c) => ({
          ...c,
          dataType: edits[c.name]?.type ?? c.dataType,
          nullable: edits[c.name]?.nullable ?? c.nullable,
        })),
    [columns, drops, edits],
  );

  const dropped = useMemo(() => Object.entries(drops).filter(([, v]) => v).map(([k]) => k), [drops]);

  const submit = async () => {
    if (!added.length && !dropped.length && !modified.length) {
      setError("没有要应用的修改");
      return;
    }
    if (added.some((a) => !a.name.trim())) {
      setError("新增列的名字不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const executed = await api.applyTableDesign(conn.id, database, table, {
        added: added.map((a) => ({
          name: a.name.trim(),
          dataType: a.type.trim() || (isSqlite ? "TEXT" : "VARCHAR(255)"),
          nullable: a.nullable,
          key: "",
          defaultValue: a.defaultValue.trim() ? a.defaultValue.trim() : null,
          extra: "",
          comment: null,
          position: 0,
          length: null,
        })),
        dropped,
        modified,
      });
      notify(`已应用 ${executed.length} 条表结构修改`, "ok");
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`设计表 · ${table}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {error ? (
              <span style={{ color: "var(--danger)" }}>{error}</span>
            ) : (
              `将执行：新增 ${added.length} / 删除 ${dropped.length} / 修改 ${modified.length}`
            )}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            <Save size={13} /> {busy ? "应用中…" : "保存修改"}
          </button>
        </>
      }
    >
      <div className="field-hint">
        {database || "main"} · {table} · 共 {columns.length} 列
        {isSqlite ? "（SQLite 只支持增删列，改类型请在 MySQL 上操作）" : ""}
      </div>

      <div className="grid-wrap" style={{ maxHeight: "18rem", border: "1px solid var(--border)", borderRadius: "0.45rem" }}>
        <table className="meta-table">
          <thead>
            <tr>
              <th>删除</th>
              <th>列名</th>
              <th>类型</th>
              <th>可空</th>
              <th>键 / 默认值</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => {
              const e = edits[c.name] ?? { type: c.dataType, nullable: c.nullable };
              const isPk = c.key.toUpperCase() === "PRI";
              return (
                <tr key={c.name} style={drops[c.name] ? { opacity: 0.45 } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(drops[c.name])}
                      disabled={isPk}
                      title={isPk ? "主键列不能直接删除" : "勾选后将从表中删除该列"}
                      onChange={(ev) => setDrops((d) => ({ ...d, [c.name]: ev.target.checked }))}
                      style={{ accentColor: "var(--accent)" }}
                    />
                  </td>
                  <td className="mono">{c.name}</td>
                  <td>
                    <input
                      className="input"
                      style={{ height: "1.6rem", width: "11rem", fontSize: "0.86rem" }}
                      value={e.type}
                      onChange={(ev) =>
                        setEdits((s) => ({ ...s, [c.name]: { ...e, type: ev.target.value } }))
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={e.nullable}
                      onChange={(ev) =>
                        setEdits((s) => ({ ...s, [c.name]: { ...e, nullable: ev.target.checked } }))
                      }
                      style={{ accentColor: "var(--accent)" }}
                    />
                  </td>
                  <td className="mono" style={{ color: "var(--text-3)", fontSize: "0.82rem" }}>
                    {c.key || "—"} / {c.defaultValue ?? "—"}
                  </td>
                </tr>
              );
            })}
            {!columns.length && (
              <tr>
                <td colSpan={5} style={{ padding: "0.8rem", color: "var(--text-3)" }}>
                  无列信息
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="field-label">新增列</span>
        <button
          className="btn sm ghost"
          onClick={() =>
            setAdded((a) => [
              ...a,
              { id: uid(), name: "", type: isSqlite ? "TEXT" : "VARCHAR(255)", nullable: true, defaultValue: "" },
            ])
          }
        >
          <Plus size={13} /> 添加列
        </button>
      </div>

      {added.map((a) => (
        <div className="filter-row" key={a.id}>
          <input
            className="input"
            style={{ width: "10rem", height: "1.7rem" }}
            placeholder="列名"
            value={a.name}
            onChange={(ev) => setAdded((list) => list.map((x) => (x.id === a.id ? { ...x, name: ev.target.value } : x)))}
          />
          <input
            className="input"
            style={{ width: "11rem", height: "1.7rem" }}
            placeholder="类型，如 VARCHAR(64)"
            value={a.type}
            onChange={(ev) => setAdded((list) => list.map((x) => (x.id === a.id ? { ...x, type: ev.target.value } : x)))}
          />
          <input
            className="input"
            style={{ width: "9rem", height: "1.7rem" }}
            placeholder="默认值（可空）"
            value={a.defaultValue}
            onChange={(ev) =>
              setAdded((list) => list.map((x) => (x.id === a.id ? { ...x, defaultValue: ev.target.value } : x)))
            }
          />
          <Checkbox
            checked={a.nullable}
            onChange={(v) => setAdded((list) => list.map((x) => (x.id === a.id ? { ...x, nullable: v } : x)))}
            label="可空"
          />
          <button
            className="icon-btn"
            title="移除"
            onClick={() => setAdded((list) => list.filter((x) => x.id !== a.id))}
            style={{ width: "1.7rem", height: "1.7rem" }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {!added.length && <div className="field-hint">需要加列时点右上「添加列」</div>}

      <Field label="预览将执行的语句（只读）">
        <pre className="code-block" style={{ maxHeight: "8rem" }}>
          {[
            ...added.map(
              (a) =>
                `ALTER TABLE ${table} ADD COLUMN ${a.name || "<列名>"} ${a.type || "<类型>"}${
                  a.nullable ? "" : " NOT NULL"
                }${a.defaultValue ? ` DEFAULT ${a.defaultValue}` : ""};`,
            ),
            ...dropped.map((d) => `ALTER TABLE ${table} DROP COLUMN ${d};`),
            ...modified.map(
              (m) =>
                `ALTER TABLE ${table} MODIFY COLUMN ${m.name} ${m.dataType}${m.nullable ? "" : " NOT NULL"};`,
            ),
          ].join("\n") || "-- 暂无修改"}
        </pre>
      </Field>
    </Modal>
  );
}
