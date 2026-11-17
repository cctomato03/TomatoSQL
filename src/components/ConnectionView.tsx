import { useState } from "react";
import { Database, Download, HardDrive, RefreshCw, Server, TerminalSquare, Upload } from "lucide-react";
import type { Connection } from "../types";
import { openQuery } from "../actions";
import { ObjectTree } from "./ObjectTree";
import { TablePanel } from "./TablePanel";
import { openTable } from "../actions";

export function ConnectionView({
  conn,
  engine,
  onExportTable,
  onImport,
  onSync,
}: {
  conn: Connection;
  engine?: string;
  onExportTable: (database: string, table: string) => void;
  onImport: (database: string, table?: string) => void;
  onSync: () => void;
}) {
  const [selected, setSelected] = useState<{ database: string; table: string } | null>(null);

  return (
    <div className="conn-view">
      <ObjectTree
        conn={conn}
        selected={selected}
        onOpenTable={(database, table) => setSelected({ database, table })}
        onOpenTableNew={(database, table) => openTable(conn, database, table)}
        onOpenQuery={(database, sql) => openQuery(conn, database, sql)}
        onImport={onImport}
      />

      <section className="content-panel">
        {selected ? (
          <TablePanel
            key={`${selected.database}.${selected.table}`}
            conn={conn}
            database={selected.database}
            table={selected.table}
            onExport={() => onExportTable(selected.database, selected.table)}
            onImport={() => onImport(selected.database, selected.table)}
          />
        ) : (
          <div className="empty" style={{ alignItems: "flex-start", textAlign: "left" }}>
            <div className="row" style={{ gap: "0.6rem" }}>
              {conn.kind === "mysql" ? (
                <Server size={20} color="var(--accent)" />
              ) : (
                <HardDrive size={20} color="var(--accent)" />
              )}
              <div className="empty-title" style={{ margin: 0 }}>
                {conn.name}
              </div>
              <span className="badge ok">
                {engine === "mysql" ? "MySQL 已连接" : "SQLite 已连接"}
              </span>
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

            <div className="field-hint" style={{ marginTop: "1.2rem", maxWidth: "34rem" }}>
              <Database size={13} style={{ verticalAlign: "-2px" }} /> 在左侧展开数据库并点击表即可查看数据；
              右键表名可生成 SELECT、导入数据，双击连接可打开多个连接标签页。
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function ExportHint({ path }: { path: string }) {
  return (
    <span className="field-hint">
      <Download size={12} style={{ verticalAlign: "-2px" }} /> {path}
    </span>
  );
}
