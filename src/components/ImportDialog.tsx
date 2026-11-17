import { useEffect, useState } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Upload } from "lucide-react";
import { api } from "../api";
import { connectTo } from "../actions";
import { useStore } from "../store";
import type { ImportResult } from "../types";
import { Checkbox, Field, Modal, Segmented } from "./ui";

export interface ImportPreset {
  connId: string;
  database?: string;
  table?: string;
}

export function ImportDialog({ preset, onClose }: { preset: ImportPreset; onClose: () => void }) {
  const connections = useStore((s) => s.ws.connections);
  const notify = useStore((s) => s.notify);

  const [connId, setConnId] = useState(preset.connId);
  const [database, setDatabase] = useState(preset.database ?? "");
  const [dbs, setDbs] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState(preset.table ?? "");
  const [format, setFormat] = useState<"csv" | "json" | "sql">("csv");
  const [filePath, setFilePath] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState(",");
  const [truncateFirst, setTruncateFirst] = useState(false);
  const [createTable, setCreateTable] = useState(true);
  const [onConflict, setOnConflict] = useState<"error" | "ignore">("error");
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connId) return;
    api.databases(connId).then(setDbs).catch(() => void 0);
  }, [connId]);

  useEffect(() => {
    if (!connId || !database) return;
    api
      .tables(connId, database)
      .then((list) => setTables(list.filter((t) => t.kind === "table").map((t) => t.name)))
      .catch(() => void 0);
  }, [connId, database]);

  const pickFile = async () => {
    const picked = await openFile({
      multiple: false,
      filters: [
        { name: "数据文件", extensions: ["csv", "json", "sql", "txt"] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (typeof picked === "string") {
      setFilePath(picked);
      const ext = picked.split(".").pop()?.toLowerCase();
      if (ext === "json") setFormat("json");
      else if (ext === "sql") setFormat("sql");
      else setFormat("csv");
      if (!table) {
        const base = picked.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
        setTable(base);
      }
    }
  };

  const run = async () => {
    if (!filePath) {
      notify("请选择要导入的文件", "err");
      return;
    }
    if (format !== "sql" && !table.trim()) {
      notify("请填写目标表名", "err");
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const conn = connections.find((c) => c.id === connId);
      if (conn && !useStore.getState().connected[connId]) {
        const ok = await connectTo(conn, false);
        if (!ok) throw new Error("连接未打开，无法导入");
      }
      const res = await api.importData({
        connId,
        database,
        table: table.trim(),
        format,
        filePath,
        hasHeader,
        delimiter: delimiter === "\\t" ? "\t" : delimiter,
        truncateFirst,
        createTable,
        onConflict,
        batchSize: 500,
        emptyAsNull,
      });
      setResult(res);
      notify(`导入完成：成功 ${res.inserted} 行`, res.failed ? "err" : "ok");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="导入数据"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {result && (
              <span style={{ color: result.failed ? "var(--warn)" : "var(--success)" }}>
                成功 {result.inserted} 行
                {result.failed ? ` · 失败 ${result.failed}` : ""} · {result.durationMs}ms
              </span>
            )}
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={running}>
            <Upload size={13} /> {running ? "导入中…" : "开始导入"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="连接">
          <select
            className="select"
            value={connId}
            onChange={(e) => {
              setConnId(e.target.value);
              setDatabase("");
              setTables([]);
            }}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="数据库">
          <select className="select" value={database} onChange={(e) => setDatabase(e.target.value)}>
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>

        <Field label="文件" full>
          <div className="row">
            <input
              className="input"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="选择 CSV / JSON / SQL 文件"
            />
            <button className="btn" onClick={() => void pickFile()}>
              <FolderOpen size={13} /> 浏览
            </button>
          </div>
        </Field>

        <Field label="格式">
          <Segmented
            value={format}
            onChange={(v) => setFormat(v)}
            options={[
              { value: "csv", label: "CSV" },
              { value: "json", label: "JSON" },
              { value: "sql", label: "SQL" },
            ]}
          />
        </Field>

        <Field label="目标表" hint={format === "sql" ? "SQL 脚本按语句执行，无需指定表" : "不存在时会按需自动建表"}>
          <input
            className="input"
            list="import-tables"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            disabled={format === "sql"}
            placeholder="表名"
          />
          <datalist id="import-tables">
            {tables.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
      </div>

      {format === "csv" && (
        <div className="row" style={{ flexWrap: "wrap", gap: "0.8rem" }}>
          <Checkbox checked={hasHeader} onChange={setHasHeader} label="首行是列名" />
          <Checkbox checked={emptyAsNull} onChange={setEmptyAsNull} label="空字符串视为 NULL" />
          <label className="row" style={{ gap: "0.35rem", fontSize: "0.9rem", color: "var(--text-2)" }}>
            分隔符
            <select
              className="input"
              style={{ width: "5.5rem", height: "1.6rem" }}
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value)}
            >
              <option value=",">, 逗号</option>
              <option value=";">; 分号</option>
              <option value="\t">Tab</option>
              <option value="|">| 竖线</option>
            </select>
          </label>
        </div>
      )}

      <div className="row" style={{ flexWrap: "wrap", gap: "0.8rem" }}>
        {format !== "sql" && (
          <>
            <Checkbox checked={createTable} onChange={setCreateTable} label="表不存在时自动建表" />
            <Checkbox
              checked={onConflict === "ignore"}
              onChange={(v) => setOnConflict(v ? "ignore" : "error")}
              label="遇到重复/错误时跳过该批"
            />
          </>
        )}
        <Checkbox
          checked={truncateFirst}
          onChange={setTruncateFirst}
          label={format === "sql" ? "清空目标表（默认不执行）" : "导入前清空目标表"}
        />
      </div>

      {result?.errors.length ? (
        <div className="log-list">
          {result.errors.map((e, i) => (
            <div key={i} className="log-item err">
              {e}
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
