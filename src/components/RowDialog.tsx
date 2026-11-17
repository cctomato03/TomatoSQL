import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ColumnInfo, Connection } from "../types";
import { Modal, Segmented } from "./ui";

type Mode = "default" | "value" | "null";

interface Entry {
  mode: Mode;
  value: string;
}

function isAutoIncrement(col: ColumnInfo): boolean {
  if (/auto_increment/i.test(col.extra)) return true;
  // SQLite: INTEGER PRIMARY KEY 是 rowid 别名，自动生成
  return (
    col.key.toUpperCase() === "PRI" &&
    /^\s*int(eger)?\b/i.test(col.dataType) &&
    !col.extra.toLowerCase().includes("default")
  );
}

export function RowDialog({
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = useMemo(() => {
    const map: Record<string, Entry> = {};
    for (const c of columns) {
      // 自增/rowid 主键交给数据库生成；其余列默认让用户填值（可切回"默认值"）
      map[c.name] = { mode: isAutoIncrement(c) ? "default" : "value", value: "" };
    }
    return map;
  }, [columns]);

  const [entries, setEntries] = useState<Record<string, Entry>>(initial);

  const setEntry = (name: string, patch: Partial<Entry>) =>
    setEntries((s) => ({ ...s, [name]: { ...s[name], ...patch } }));

  const submit = async () => {
    const values: { column: string; value: string | null }[] = [];
    for (const c of columns) {
      const e = entries[c.name] ?? { mode: "default", value: "" };
      if (e.mode === "default") continue;
      if (e.mode === "null") {
        if (!c.nullable) {
          setError(`列「${c.name}」不允许 NULL，请填写值`);
          return;
        }
        values.push({ column: c.name, value: null });
        continue;
      }
      const v = e.value;
      if (v === "") {
        if (!c.nullable) {
          setError(`列「${c.name}」不允许为空，请填写值`);
          return;
        }
        values.push({ column: c.name, value: null });
        continue;
      }
      values.push({ column: c.name, value: v });
    }

    setSaving(true);
    setError(null);
    try {
      const id = await api.insertRow(conn.id, database, table, values);
      notify(id > 0 ? `已新增 1 行（主键 ${id}）` : "已新增 1 行", "ok");
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`新增行 · ${table}`}
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {error ? (
              <span style={{ color: "var(--danger)" }}>{error}</span>
            ) : (
              "留空并使用「默认值」的列由数据库自动填充"
            )}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={saving}>
            <Plus size={13} /> {saving ? "插入中…" : "插入"}
          </button>
        </>
      }
    >
      <div className="field-hint">
        {conn.kind === "mysql" ? "MySQL" : "SQLite"} · {database || "main"} · {table}
        ，共 {columns.length} 列
      </div>

      <div className="row-form">
        {columns.map((c) => {
          const e = entries[c.name] ?? { mode: "default", value: "" };
          const auto = isAutoIncrement(c);
          return (
            <div className="row-form-item" key={c.name}>
              <div className="row-form-label">
                <span className="mono">{c.name}</span>
                <span className="row-form-meta">
                  {c.dataType || "—"}
                  {c.key.toUpperCase() === "PRI" ? " · 主键" : ""}
                  {!c.nullable ? " · 必填" : ""}
                  {c.defaultValue != null ? ` · 默认 ${c.defaultValue}` : ""}
                </span>
              </div>
              <div className="row-form-controls">
                <Segmented
                  value={e.mode}
                  onChange={(v) => setEntry(c.name, { mode: v })}
                  options={[
                    ...(auto
                      ? [{ value: "default" as Mode, label: "自动" }]
                      : [{ value: "default" as Mode, label: "默认值" }]),
                    { value: "value" as Mode, label: "输入" },
                    { value: "null" as Mode, label: "NULL" },
                  ]}
                />
                {e.mode === "value" && (
                  <input
                    className="input"
                    autoFocus={!auto && !c.nullable && c.defaultValue == null}
                    value={e.value}
                    placeholder={c.nullable ? "可留空" : "必填"}
                    onChange={(ev) => setEntry(c.name, { value: ev.target.value })}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") void submit();
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
