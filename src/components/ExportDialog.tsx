import { useEffect, useMemo, useState } from "react";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen } from "lucide-react";
import { api } from "../api";
import { connectTo } from "../actions";
import { useStore } from "../store";
import type { Connection, ExportResult, TableInfo } from "../types";
import { Checkbox, Field, Modal, Segmented } from "./ui";

export interface ExportPreset {
  connId: string;
  database?: string;
  tables?: string[];
  sql?: string;
}

export function ExportDialog({ preset, onClose }: { preset: ExportPreset; onClose: () => void }) {
  const connections = useStore((s) => s.ws.connections);
  const notify = useStore((s) => s.notify);

  const [connId, setConnId] = useState(preset.connId);
  const [database, setDatabase] = useState(preset.database ?? "");
  const [dbs, setDbs] = useState<string[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [picked, setPicked] = useState<string[]>(preset.tables ?? []);
  const [format, setFormat] = useState<"csv" | "json" | "sql">("sql");
  const [delimiter, setDelimiter] = useState(",");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [includeStructure, setIncludeStructure] = useState(false);
  const [nullAs, setNullAs] = useState("");
  const [filePath, setFilePath] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isQuery = Boolean(preset.sql);
  const conn: Connection | undefined = useMemo(
    () => connections.find((c) => c.id === connId),
    [connections, connId],
  );

  useEffect(() => {
    if (!connId) return;
    api
      .databases(connId)
      .then((list) => {
        setDbs(list);
        if (!database && list.length) setDatabase(preset.database ?? list[0]);
      })
      .catch(() => void 0);
  }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!connId || !database || isQuery) return;
    api
      .tables(connId, database)
      .then((list) => {
        setTables(list.filter((t) => t.kind === "table"));
        setPicked((p) => (p.length ? p : preset.tables ?? list.filter((t) => t.kind === "table").map((t) => t.name)));
      })
      .catch(() => void 0);
  }, [connId, database, isQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFile = async () => {
    const ext = format === "sql" ? "sql" : format;
    const target = await saveFile({
      defaultPath: isQuery ? `query_result.${ext}` : `${database || "export"}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (typeof target === "string") setFilePath(target);
  };

  const run = async () => {
    if (!filePath) {
      notify("请选择导出文件路径", "err");
      return;
    }
    if (!isQuery && !picked.length) {
      notify("请至少选择一个表", "err");
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      if (conn && !useStore.getState().connected[connId]) {
        const ok = await connectTo(conn, false);
        if (!ok) throw new Error("连接未打开，无法导出");
      }
      const res = await api.exportData({
        connId,
        database,
        tables: isQuery ? [] : picked,
        sql: preset.sql ?? null,
        format,
        filePath,
        includeHeader,
        delimiter,
        includeStructure,
        nullAs: nullAs || null,
        batchSize: 1000,
      });
      setResult(res);
      notify(`导出完成：${res.rows} 行`, "ok");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={isQuery ? "导出查询结果" : "导出数据"}
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {result && (
              <span style={{ color: "var(--success)" }}>
                已导出 {result.rows} 行 / {result.tables} 个对象（{(result.bytes / 1024).toFixed(1)} KB）
              </span>
            )}
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={running}>
            <Download size={13} /> {running ? "导出中…" : "开始导出"}
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
              setPicked([]);
            }}
            disabled={isQuery}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="数据库">
          <select
            className="select"
            value={database}
            onChange={(e) => {
              setDatabase(e.target.value);
              setPicked([]);
            }}
            disabled={isQuery}
          >
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>

        <Field label="格式">
          <Segmented
            value={format}
            onChange={(v) => setFormat(v)}
            options={[
              { value: "sql", label: "SQL" },
              { value: "csv", label: "CSV" },
              { value: "json", label: "JSON" },
            ]}
          />
        </Field>
        <Field label="文件路径">
          <div className="row">
            <input
              className="input"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="选择保存位置"
            />
            <button className="btn" onClick={() => void pickFile()}>
              <FolderOpen size={13} /> 浏览
            </button>
          </div>
        </Field>
      </div>

      {!isQuery && (
        <Field label={`选择表（已选 ${picked.length} 个）`}>
          <div style={{ maxHeight: "11rem", overflow: "auto", border: "1px solid var(--border)", borderRadius: "0.45rem", padding: "0.4rem" }}>
            <div className="row" style={{ marginBottom: "0.3rem", gap: "0.6rem" }}>
              <button className="btn sm ghost" onClick={() => setPicked(tables.map((t) => t.name))}>
                全选
              </button>
              <button className="btn sm ghost" onClick={() => setPicked([])}>
                清空
              </button>
              <span className="toolbar-hint">多表导出 CSV/SQL 时会按表名生成多个文件</span>
            </div>
            {tables.map((t) => (
              <Checkbox
                key={t.name}
                checked={picked.includes(t.name)}
                onChange={(v) =>
                  setPicked((p) => (v ? [...p, t.name] : p.filter((x) => x !== t.name)))
                }
                label={<span className="mono">{t.name}</span>}
              />
            ))}
            {!tables.length && <div className="field-hint">该库没有可导出的表</div>}
          </div>
        </Field>
      )}

      <div className="row" style={{ flexWrap: "wrap", gap: "0.8rem" }}>
        {format === "csv" && (
          <>
            <Checkbox checked={includeHeader} onChange={setIncludeHeader} label="包含表头" />
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
            <label className="row" style={{ gap: "0.35rem", fontSize: "0.9rem", color: "var(--text-2)" }}>
              NULL 显示为
              <input
                className="input"
                style={{ width: "5rem", height: "1.6rem" }}
                value={nullAs}
                onChange={(e) => setNullAs(e.target.value)}
                placeholder="(空)"
              />
            </label>
          </>
        )}
        {format === "sql" && (
          <Checkbox checked={includeStructure} onChange={setIncludeStructure} label="同时导出建表语句（DDL）" />
        )}
      </div>

      {conn && (
        <div className="field-hint">
          来源：{conn.name} · {database || "—"} {isQuery ? "· 查询结果" : `· ${picked.length} 张表`}
        </div>
      )}
    </Modal>
  );
}
