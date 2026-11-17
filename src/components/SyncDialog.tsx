import { useEffect, useMemo, useState } from "react";
import { ArrowRight, GitCompare, Play, RefreshCw } from "lucide-react";
import { api } from "../api";
import { connectTo } from "../actions";
import { useStore } from "../store";
import type { CompareReport, SyncResult, TableDiff } from "../types";
import { Checkbox, Field, Modal } from "./ui";

const STATUS_TEXT: Record<string, string> = {
  onlySource: "仅源库有",
  onlyTarget: "仅目标库有",
  both: "有差异",
  same: "一致",
};

export function SyncDialog({ sourceConnId, onClose }: { sourceConnId?: string; onClose: () => void }) {
  const connections = useStore((s) => s.ws.connections);
  const connected = useStore((s) => s.connected);
  const notify = useStore((s) => s.notify);

  const [srcConn, setSrcConn] = useState(sourceConnId ?? connections[0]?.id ?? "");
  const [dstConn, setDstConn] = useState(
    connections.find((c) => c.id !== (sourceConnId ?? connections[0]?.id))?.id ?? "",
  );
  const [srcDbs, setSrcDbs] = useState<string[]>([]);
  const [dstDbs, setDstDbs] = useState<string[]>([]);
  const [srcDb, setSrcDb] = useState("");
  const [dstDb, setDstDb] = useState("");
  const [report, setReport] = useState<CompareReport | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createTables, setCreateTables] = useState(true);
  const [addColumns, setAddColumns] = useState(true);
  const [createIndexes, setCreateIndexes] = useState(true);
  const [copyData, setCopyData] = useState(false);
  const [truncateTarget, setTruncateTarget] = useState(false);
  const [dropTargetTables, setDropTargetTables] = useState(false);

  useEffect(() => {
    if (!srcConn) return;
    api.databases(srcConn).then((l) => {
      setSrcDbs(l);
      if (!srcDb) setSrcDb(l[0] ?? "");
    }).catch(() => void 0);
  }, [srcConn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dstConn) return;
    api.databases(dstConn).then((l) => {
      setDstDbs(l);
      if (!dstDb) setDstDb(l[0] ?? "");
    }).catch(() => void 0);
  }, [dstConn]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureConnected = async (connId: string) => {
    if (connected[connId]) return true;
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return false;
    return connectTo(conn, false);
  };

  const compare = async () => {
    if (!srcConn || !dstConn || !srcDb || !dstDb) {
      notify("请选择源与目标的连接/数据库", "err");
      return;
    }
    if (srcConn === dstConn && srcDb === dstDb) {
      notify("源和目标相同，无需比较", "err");
      return;
    }
    setComparing(true);
    setError(null);
    setResult(null);
    try {
      await ensureConnected(srcConn);
      await ensureConnected(dstConn);
      const rep = await api.compare({
        sourceConn: srcConn,
        sourceDb: srcDb,
        targetConn: dstConn,
        targetDb: dstDb,
        tables: [],
        compareData: true,
      });
      setReport(rep);
      setPicked(
        rep.tables
          .filter((t) => t.status === "onlySource" || t.hasStructureChange || t.status === "both")
          .map((t) => t.name),
      );
      notify(`比较完成：${rep.tables.length} 张表，耗时 ${rep.durationMs}ms`, "ok");
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
    }
  };

  const apply = async () => {
    if (!picked.length) {
      notify("请选择要同步的表", "err");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await api.applySync({
        sourceConn: srcConn,
        sourceDb: srcDb,
        targetConn: dstConn,
        targetDb: dstDb,
        tables: picked,
        createTables,
        addColumns,
        createIndexes,
        copyData,
        truncateTarget,
        dropTargetTables,
      });
      setResult(res);
      notify(`同步完成：成功 ${res.succeeded} 步，失败 ${res.failed} 步`, res.failed ? "err" : "ok");
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const summary = useMemo(() => {
    if (!report) return null;
    return {
      onlySource: report.tables.filter((t) => t.status === "onlySource").length,
      onlyTarget: report.tables.filter((t) => t.status === "onlyTarget").length,
      changed: report.tables.filter((t) => t.hasStructureChange && t.status === "both").length,
      same: report.tables.filter((t) => !t.hasStructureChange).length,
    };
  }, [report]);

  const detailOf = (t: TableDiff) => {
    const parts: string[] = [];
    const missTarget = t.columns.filter((c) => c.status === "missingInTarget").length;
    const missSource = t.columns.filter((c) => c.status === "missingInSource").length;
    const mismatch = t.columns.filter((c) => c.status === "typeMismatch").length;
    if (missTarget) parts.push(`缺列 ${missTarget}`);
    if (mismatch) parts.push(`类型不同 ${mismatch}`);
    if (missSource) parts.push(`目标多列 ${missSource}`);
    if (t.indexes.length) parts.push(`索引差异 ${t.indexes.length}`);
    if (t.status === "onlySource") parts.push("目标库缺少该表");
    if (t.status === "onlyTarget") parts.push("源库没有该表（不会删除）");
    if (t.sourceRows || t.targetRows) parts.push(`行数 ${t.sourceRows} → ${t.targetRows}`);
    return parts.join(" · ") || "结构一致";
  };

  return (
    <Modal
      title="结构同步 / 数据迁移"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
            {result && (
              <span style={{ color: result.failed ? "var(--warn)" : "var(--success)" }}>
                成功 {result.succeeded} 步{result.failed ? `，失败 ${result.failed} 步` : ""}
              </span>
            )}
          </span>
          <button className="btn" onClick={() => void compare()} disabled={comparing}>
            <GitCompare size={13} /> {comparing ? "比较中…" : "比较结构"}
          </button>
          <button className="btn primary" onClick={() => void apply()} disabled={running || !picked.length}>
            <Play size={13} /> {running ? "执行中…" : `执行同步（${picked.length}）`}
          </button>
        </>
      }
    >
      <div className="row" style={{ alignItems: "flex-end", gap: "0.5rem", flexWrap: "wrap" }}>
        <Field label="源连接（以此为基准）">
          <select className="select" value={srcConn} onChange={(e) => setSrcConn(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.kind}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="源数据库">
          <select className="select" value={srcDb} onChange={(e) => setSrcDb(e.target.value)}>
            {srcDbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <ArrowRight size={16} style={{ marginBottom: "0.5rem", color: "var(--text-3)" }} />
        <Field label="目标连接（将被修改）">
          <select className="select" value={dstConn} onChange={(e) => setDstConn(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.kind}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="目标数据库">
          <select className="select" value={dstDb} onChange={(e) => setDstDb(e.target.value)}>
            {dstDbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: "0.9rem" }}>
        <Checkbox checked={createTables} onChange={setCreateTables} label="创建缺失的表" />
        <Checkbox checked={addColumns} onChange={setAddColumns} label="新增缺失的列" />
        <Checkbox checked={createIndexes} onChange={setCreateIndexes} label="创建缺失的索引" />
        <Checkbox checked={copyData} onChange={setCopyData} label="复制表数据" />
        <Checkbox
          checked={truncateTarget}
          onChange={setTruncateTarget}
          label="复制前清空目标表"
          disabled={!copyData}
        />
        <Checkbox
          checked={dropTargetTables}
          onChange={setDropTargetTables}
          label="删除并重建同名表"
        />
      </div>

      {summary && (
        <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
          <span className="badge info">仅源库 {summary.onlySource}</span>
          <span className="badge warn">有差异 {summary.changed}</span>
          <span className="badge">一致 {summary.same}</span>
          <span className="badge">仅目标 {summary.onlyTarget}</span>
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => setPicked(report!.tables.filter((t) => t.status === "onlySource" || t.hasStructureChange).map((t) => t.name))}>
            选中需要同步的
          </button>
          <button className="btn sm ghost" onClick={() => setPicked([])}>
            清空
          </button>
        </div>
      )}

      {report && (
        <div className="diff-list">
          {report.tables.map((t) => (
            <div className="diff-item" key={t.name}>
              <input
                type="checkbox"
                checked={picked.includes(t.name)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, t.name] : p.filter((x) => x !== t.name)))
                }
                style={{ accentColor: "var(--accent)" }}
              />
              <span className="name mono">{t.name}</span>
              <span
                className={`badge ${
                  t.status === "onlySource"
                    ? "info"
                    : t.status === "onlyTarget"
                      ? "warn"
                      : t.hasStructureChange
                        ? "warn"
                        : "ok"
                }`}
              >
                {STATUS_TEXT[t.status] ?? t.status}
              </span>
              <span className="diff-detail">{detailOf(t)}</span>
            </div>
          ))}
          {!report.tables.length && <div className="diff-item">没有可比较的表</div>}
        </div>
      )}

      {!report && (
        <div className="field-hint">
          选择源库与目标库后点击「比较结构」，TomatoSQL 会列出差异（缺失表、缺失列、类型不一致、索引差异），
          确认后即可把目标库同步为源库结构。支持 MySQL ↔ SQLite 跨引擎迁移。
        </div>
      )}

      {result && (
        <div className="log-list">
          {result.steps.map((s, i) => (
            <div key={i} className={`log-item ${s.ok ? "ok" : "err"}`}>
              <span>[{s.table}]</span>
              <span>{s.message}</span>
              {s.sql && <span style={{ color: "var(--text-3)" }}>{s.sql.slice(0, 160)}</span>}
            </div>
          ))}
        </div>
      )}

      {comparing && (
        <div className="row">
          <RefreshCw size={13} className="spin" /> <span className="field-hint">正在比较…</span>
        </div>
      )}
    </Modal>
  );
}
