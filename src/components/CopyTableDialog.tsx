import { useState } from "react";
import { CopyPlus } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Connection } from "../types";
import { Checkbox, Field, Modal, Segmented } from "./ui";

/** 复制表：仅结构 / 结构 + 数据 */
export function CopyTableDialog({
  conn,
  database,
  table,
  onClose,
  onDone,
}: {
  conn: Connection;
  database: string;
  table: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [newName, setNewName] = useState(`${table}_copy`);
  const [withData, setWithData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.copyTable(conn.id, database, table, newName.trim(), withData);
      notify(`已复制为 ${newName.trim()}（${withData ? "结构 + 数据" : "仅结构"}）`, "ok");
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
      title={`复制表 · ${table}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            <CopyPlus size={13} /> {busy ? "复制中…" : "复制"}
          </button>
        </>
      }
    >
      <div className="field-hint">
        在当前库 {database || "main"} 中把 {table} 复制成一张新表
      </div>
      <Field label="新表名">
        <input
          className="input"
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>
      <div className="col" style={{ gap: "0.4rem" }}>
        <span className="field-label">复制内容</span>
        <Segmented
          value={withData ? "data" : "structure"}
          onChange={(v) => setWithData(v === "data")}
          options={[
            { value: "structure", label: "仅结构" },
            { value: "data", label: "结构 + 数据" },
          ]}
        />
        <span className="field-hint">
          {withData
            ? "会复制表结构与全部数据行（大表可能较慢）"
            : "只复制列定义与索引，不含数据"}
        </span>
      </div>
      <Checkbox checked={withData} onChange={setWithData} label="同时复制数据" />
    </Modal>
  );
}
