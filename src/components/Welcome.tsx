import { Cloud, Database, Download, FolderTree, HardDrive, Palette, Plus, RefreshCw, TerminalSquare } from "lucide-react";
import { useStore } from "../store";
import { connectTo } from "../actions";
import type { Connection } from "../types";

const FEATURES = [
  {
    icon: <Database size={15} />,
    title: "MySQL / SQLite",
    text: "统一的连接管理，密码加密保存在本地。",
  },
  {
    icon: <TerminalSquare size={15} />,
    title: "SQL 编辑器",
    text: "多语句执行、结果分页、单元格直接编辑。",
  },
  {
    icon: <FolderTree size={15} />,
    title: "分组与多连接",
    text: "左侧分组树，右侧多标签并行操作。",
  },
  {
    icon: <Download size={15} />,
    title: "导入导出 / 迁移",
    text: "CSV、JSON、SQL 互转，结构比较与同步。",
  },
  {
    icon: <Palette size={15} />,
    title: "主题与字号",
    text: "内置 8 套主题，字号与编辑器字体可调。",
  },
  {
    icon: <Cloud size={15} />,
    title: "云同步",
    text: "自建 Docker 服务，端到端加密同步连接。",
  },
];

export function Welcome({
  onNewConnection,
  onOpenCloud,
  onOpenSync,
}: {
  onNewConnection: (kind: "mysql" | "sqlite") => void;
  onOpenCloud: () => void;
  onOpenSync: () => void;
}) {
  const ws = useStore((s) => s.ws);
  const connected = useStore((s) => s.connected);
  const recent: Connection[] = [...ws.connections]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 6);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "2.4rem 2.6rem" }}>
      <div style={{ maxWidth: "62rem", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
          <div className="brand-logo" style={{ width: "2.8rem", height: "2.8rem", borderRadius: "0.8rem", fontSize: "1.3rem" }}>
            T
          </div>
          <div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
              TomatoSQL
            </div>
            <div className="field-hint" style={{ fontSize: "0.95rem" }}>
              跨平台数据库管理工具 · MySQL / SQLite · Windows / macOS / Linux
            </div>
          </div>
        </div>

        <div className="row" style={{ marginTop: "1.6rem", flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => onNewConnection("mysql")}>
            <Plus size={14} /> 新建 MySQL 连接
          </button>
          <button className="btn" onClick={() => onNewConnection("sqlite")}>
            <HardDrive size={14} /> 打开 SQLite 文件
          </button>
          <button className="btn" onClick={onOpenSync}>
            <RefreshCw size={14} /> 结构同步 / 数据迁移
          </button>
          <button className="btn" onClick={onOpenCloud}>
            <Cloud size={14} /> 云同步
          </button>
        </div>

        {recent.length > 0 && (
          <>
            <div style={{ marginTop: "2rem", fontSize: "0.95rem", fontWeight: 600, color: "var(--text-2)" }}>
              最近使用的连接
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))",
                gap: "0.6rem",
                marginTop: "0.6rem",
              }}
            >
              {recent.map((c) => (
                <button
                  key={c.id}
                  className="btn"
                  style={{ height: "auto", padding: "0.6rem 0.7rem", justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() => void connectTo(c)}
                  title={c.kind === "mysql" ? `${c.host}:${c.port}` : c.file ?? ""}
                >
                  <span className={`conn-dot ${connected[c.id] ? "on" : "off"}`} />
                  <span style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.name}
                    </span>
                    <span className="field-hint" style={{ fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.kind === "mysql" ? `${c.host ?? ""}:${c.port ?? 3306}` : c.file ?? "未选择文件"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))",
            gap: "0.7rem",
            marginTop: "2rem",
          }}
        >
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "0.55rem",
                padding: "0.7rem 0.8rem",
                background: "var(--bg-2)",
                display: "flex",
                gap: "0.55rem",
              }}
            >
              <span style={{ color: "var(--accent)", marginTop: "0.1rem" }}>{f.icon}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>{f.title}</div>
                <div className="field-hint" style={{ fontSize: "0.82rem" }}>
                  {f.text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
