import { useState } from "react";
import { Play } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Connection } from "../types";
import { Modal } from "./ui";

/**
 * 通用 SQL 脚本弹窗：新建表 / 视图 / 函数等都用它
 * （预填一段模板，用户改完直接执行）
 */
export function SqlScriptDialog({
  conn,
  database,
  title,
  hint,
  initialSql,
  onClose,
  onDone,
}: {
  conn: Connection;
  database: string;
  title: string;
  hint?: string;
  initialSql: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [sql, setSql] = useState(initialSql);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async () => {
    if (!sql.trim()) {
      setMessage({ ok: false, text: "SQL 不能为空" });
      return;
    }
    setRunning(true);
    setMessage(null);
    try {
      const results = await api.query(conn.id, database, sql, 100);
      const affected = results.reduce(
        (n, r) => n + (r.rows.length ? r.rows.length : r.rowsAffected),
        0,
      );
      setMessage({ ok: true, text: `执行成功：${results.length} 条语句，影响 ${affected} 行` });
      notify(`${title}成功`, "ok");
      onDone();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`${title} · ${database || conn.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {message && (
              <span style={{ color: message.ok ? "var(--success)" : "var(--danger)" }}>
                {message.text}
              </span>
            )}
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={running}>
            <Play size={13} /> {running ? "执行中…" : "执行"}
          </button>
        </>
      }
    >
      {hint && <div className="field-hint">{hint}</div>}
      <textarea
        className="sql-editor"
        style={{
          minHeight: "16rem",
          border: "1px solid var(--border-2)",
          borderRadius: "0.45rem",
          background: "var(--bg-input)",
        }}
        spellCheck={false}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
      />
      {message && !message.ok && <div className="msg-line err">{message.text}</div>}
    </Modal>
  );
}

/** 新建视图的模板 */
export function viewTemplate(name: string, database: string) {
  const table = database ? `${database}.t1` : "t1";
  return `CREATE VIEW ${name} AS\nSELECT *\nFROM ${table}\nWHERE 1 = 1;`;
}

/** 新建表的模板 */
export function tableTemplate(name: string) {
  return `CREATE TABLE ${name} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);`;
}

/** 新建函数（MySQL）模板 */
export function functionTemplate(name: string) {
  return `CREATE FUNCTION ${name}(x INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN x * 2;\nEND;`;
}
