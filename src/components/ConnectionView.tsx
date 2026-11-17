import { Database, HardDrive, RefreshCw, Table2, TerminalSquare, Upload } from "lucide-react";
import type { Connection } from "../types";
import { openQuery, openTable } from "../actions";
import { ObjectTree } from "./ObjectTree";

export function ConnectionView({
  conn,
  engine,
  onImport,
  onSync,
}: {
  conn: Connection;
  engine?: string;
  onImport: (database: string, table?: string) => void;
  onSync: () => void;
}) {
  return (
    <div className="conn-view">
      <ObjectTree
        conn={conn}
        onOpenTable={(database, table) => openTable(conn, database, table)}
        onOpenQuery={(database, sql) => openQuery(conn, database, sql)}
        onImport={onImport}
      />

      <section className="content-panel">
        <div className="empty" style={{ alignItems: "flex-start", textAlign: "left" }}>
          <div className="row" style={{ gap: "0.6rem" }}>
            {conn.kind === "mysql" ? (
              <Database size={20} color="var(--accent)" />
            ) : (
              <HardDrive size={20} color="var(--accent)" />
            )}
            <div className="empty-title" style={{ margin: 0 }}>
              {conn.name}
            </div>
            <span className="badge ok">{engine === "mysql" ? "MySQL 已连接" : "SQLite 已连接"}</span>
          </div>

          <div className="field-hint" style={{ fontSize: "0.9rem", lineHeight: 1.9 }}>
            {conn.kind === "mysql" ? (
              <>
                主机：{conn.host}:{conn.port} · 用户：{conn.user ?? "-"}
                {conn.charset ? ` · 字符集：${conn.charset}` : ""}
                {conn.sslMode && conn.sslMode !== "disabled" ? ` · SSL：${conn.sslMode}` : ""}
              </>
            ) : (
              <>文件：{conn.file}</>
            )}
          </div>

          <div className="row" style={{ marginTop: "0.8rem", flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => openQuery(conn, "", "")}>
              <TerminalSquare size={14} /> 新建查询
            </button>
            <button className="btn" onClick={() => onImport("")}>
              <Upload size={14} /> 导入数据
            </button>
            <button className="btn" onClick={onSync}>
              <RefreshCw size={14} /> 结构同步 / 迁移
            </button>
          </div>

          <div className="conn-tips">
            <div>
              <span className="kbd-hint">单击</span> 选择数据库 / 表；<span className="kbd-hint">双击</span>{" "}
              展开数据库、打开表数据（新标签页）；点箭头可只展开/收起。
            </div>
            <div style={{ marginTop: "0.4rem" }}>
              <Table2 size={12} style={{ verticalAlign: "-2px" }} /> 每张表都在独立标签页里打开，可同时查看多张表，互不影响。
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
