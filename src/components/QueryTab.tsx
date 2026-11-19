import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eraser, Play, Save, SquareTerminal, Rows3 } from "lucide-react";
import { api } from "../api";
import { useStore, type Tab } from "../store";
import type { Connection, QueryResult } from "../types";
import { DataGrid } from "./DataGrid";
import { Modal } from "./ui";

export function QueryTab({
  tab,
  conn,
  onExport,
}: {
  tab: Tab;
  conn: Connection;
  onExport: (sql: string) => void;
}) {
  const notify = useStore((s) => s.notify);
  const patchTab = useStore((s) => s.patchTab);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const showLineNumbers = useStore((s) => s.ws.settings.showLineNumbers);

  const [sql, setSql] = useState(tab.sql ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [dbs, setDbs] = useState<string[]>([]);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [maxRows, setMaxRows] = useState(5000);
  const [editorHeight, setEditorHeight] = useState(180);
  const [saveName, setSaveName] = useState<string | null>(null);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .databases(conn.id)
      .then((list) => {
        setDbs(list);
        if (!database && list.length) setDatabase(list[0]);
      })
      .catch(() => void 0);
  }, [conn.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab.sql && tab.sql !== sql) setSql(tab.sql);
  }, [tab.sql]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineCount = useMemo(() => sql.split("\n").length, [sql]);

  const run = useCallback(
    async (text?: string) => {
      const el = editorRef.current;
      let body = text ?? sql;
      if (!text && el && el.selectionStart !== el.selectionEnd) {
        body = sql.slice(el.selectionStart, el.selectionEnd);
      }
      if (!body.trim()) {
        notify("请输入 SQL 语句", "err");
        return;
      }
      setRunning(true);
      setError(null);
      const started = performance.now();
      try {
        const res = await api.query(conn.id, database, body, maxRows);
        setResults(res);
        setActiveResult(0);
        setDuration(Math.round(performance.now() - started));
        const affected = res.reduce((n, r) => n + (r.rows.length ? r.rows.length : r.rowsAffected), 0);
        notify(`执行完成：${res.length} 条语句，${affected} 行`, "ok");
      } catch (e) {
        setError(String(e));
        setResults([]);
        setDuration(Math.round(performance.now() - started));
      } finally {
        setRunning(false);
      }
    },
    [sql, conn.id, database, maxRows, notify],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void run();
      }
      if (e.key === "F5") {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  const current = results[activeResult];

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev: MouseEvent) => {
      const h = Math.min(window.innerHeight - 220, Math.max(90, startH + ev.clientY - startY));
      setEditorHeight(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="query-view">
      <div className="grid-toolbar">
        <button className="btn sm primary" onClick={() => void run()} disabled={running} title="Ctrl/Cmd + Enter">
          <Play size={13} /> {running ? "执行中…" : "运行"}
        </button>
        <button className="btn sm" onClick={() => void run()} disabled={running || !sql.trim()}>
          <SquareTerminal size={13} /> 运行选中
        </button>
        <button
          className="btn sm ghost"
          onClick={() => {
            setSql("");
            setResults([]);
            setError(null);
            patchTab(tab.id, { sql: "" });
          }}
          title="清空编辑器"
        >
          <Eraser size={13} /> 清空
        </button>
        <select
          className="input"
          style={{ width: "9rem", height: "1.6rem", fontSize: "0.85rem" }}
          value={database}
          onChange={(e) => {
            setDatabase(e.target.value);
            patchTab(tab.id, { database: e.target.value });
          }}
          title="默认数据库"
        >
          {dbs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
          {!dbs.length && <option value="">（无）</option>}
        </select>
        <span className="grow" />
        <span className="toolbar-hint">
          <Rows3 size={12} style={{ verticalAlign: "-2px" }} /> 最多返回
        </span>
        <select
          className="input"
          style={{ width: "5.5rem", height: "1.6rem", fontSize: "0.85rem" }}
          value={maxRows}
          onChange={(e) => setMaxRows(Number(e.target.value))}
        >
          {[1000, 5000, 20000, 100000].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          className="btn sm"
          disabled={!sql.trim()}
          onClick={() => onExport(sql)}
          title="把当前 SQL 的结果导出为文件"
        >
          <Download size={13} /> 导出结果
        </button>
        <button
          className="btn sm"
          disabled={!sql.trim()}
          onClick={() => setSaveName(`查询 ${new Date().toLocaleTimeString()}`)}
          title="保存到左侧栏的『查询』节点"
        >
          <Save size={13} /> 保存查询
        </button>
      </div>

      <div className="editor-area" style={{ height: editorHeight }}>
        {showLineNumbers && (
          <div className="editor-gutter" ref={gutterRef}>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        )}
        <textarea
          ref={editorRef}
          className="sql-editor"
          spellCheck={false}
          value={sql}
          placeholder={"-- 在此输入 SQL，Ctrl/Cmd + Enter 执行\n-- 例如：SELECT * FROM users LIMIT 20;"}
          onChange={(e) => {
            setSql(e.target.value);
            patchTab(tab.id, { sql: e.target.value });
          }}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const el = e.currentTarget;
              const s = el.selectionStart;
              const next = `${sql.slice(0, s)}  ${sql.slice(el.selectionEnd)}`;
              setSql(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = s + 2;
              });
            }
          }}
        />
      </div>

      <div className="splitter-h" onMouseDown={startResize} />

      <div className="result-area">
        {results.length > 1 && (
          <div className="result-tabs">
            {results.map((r, i) => (
              <button
                key={i}
                className={`result-tab ${i === activeResult ? "active" : ""}`}
                onClick={() => setActiveResult(i)}
                title={r.statement}
              >
                结果 {i + 1}
                {r.rows.length ? ` · ${r.rows.length} 行` : ` · ${r.rowsAffected} 影响`}
              </button>
            ))}
          </div>
        )}

        {error && <div className="msg-line err">{error}</div>}

        {!error && current && (
          <>
            <div className="grid-toolbar" style={{ borderTop: "none" }}>
              <span className={`badge ${current.rows.length ? "ok" : "info"}`}>
                {current.rows.length ? `${current.rows.length} 行` : `影响 ${current.rowsAffected} 行`}
              </span>
              <span className="toolbar-hint">耗时 {current.durationMs}ms</span>
              {current.truncated && <span className="badge warn">结果已截断</span>}
              {current.lastInsertId != null && current.lastInsertId > 0 && (
                <span className="toolbar-hint">自增 ID：{current.lastInsertId}</span>
              )}
              <span className="grow" />
              <span className="toolbar-hint mono" style={{ maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {current.statement}
              </span>
            </div>
            <DataGrid columns={current.columns} rows={current.rows} emptyText="该语句没有返回结果集。" />
          </>
        )}

        {!error && !results.length && (
          <div className="empty">
            <div className="empty-title">准备就绪</div>
            <div className="empty-text">
              输入 SQL 后按 Ctrl/Cmd + Enter 执行；选中部分文本则只执行选中的语句。
            </div>
          </div>
        )}

        {!error && !results.length && duration != null && (
          <div className="pager">耗时 {duration}ms</div>
        )}
      </div>

      {saveName !== null && (
        <Modal
          title="保存查询"
          size="sm"
          onClose={() => setSaveName(null)}
          footer={
            <>
              <button className="btn" onClick={() => setSaveName(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const name = saveName.trim();
                  if (!name) {
                    notify("请填写查询名称", "err");
                    return;
                  }
                  addSavedQuery({ name, connId: conn.id, database, sql });
                  notify(`已保存查询「${name}」到左侧『查询』节点`, "ok");
                  setSaveName(null);
                }}
              >
                保存
              </button>
            </>
          }
        >
          <div className="field-hint" style={{ marginBottom: "0.5rem" }}>
            保存到左侧栏 {conn.name} → {database || "（默认库）"} → 查询，之后双击即可再次打开。
          </div>
          <input
            className="input"
            autoFocus
            placeholder="查询名称"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.currentTarget as HTMLInputElement).blur();
                const name = saveName.trim();
                if (!name) return;
                addSavedQuery({ name, connId: conn.id, database, sql });
                notify(`已保存查询「${name}」到左侧『查询』节点`, "ok");
                setSaveName(null);
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}
