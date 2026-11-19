import { useState } from "react";
import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { Database, FolderOpen } from "lucide-react";
import { api } from "../api";
import { newConnection, useStore } from "../store";
import type { Connection } from "../types";
import { Field, Modal } from "./ui";

/**
 * 新建数据库
 * - MySQL：输入库名 + 字符集，执行 CREATE DATABASE
 * - SQLite：选择一个新文件路径，创建空的 .db 文件并自动新增一个连接
 */
export function CreateDatabaseDialog({
  conn,
  onClose,
  onDone,
}: {
  conn: Connection;
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const upsertConnection = useStore((s) => s.upsertConnection);
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [filePath, setFilePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMysql = conn.kind === "mysql";

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (isMysql) {
        const db = name.trim();
        if (!db) throw new Error("请填写数据库名");
        await api.createDatabase(conn.id, db, charset);
        notify(`数据库 ${db} 创建成功`, "ok");
      } else {
        if (!filePath) throw new Error("请选择要创建的 SQLite 文件");
        await api.touchSqliteDb(filePath);
        const created = {
          ...newConnection("sqlite"),
          name: filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "新建 SQLite 数据库",
          file: filePath,
          groupId: conn.groupId ?? null,
        };
        upsertConnection(created);
        notify(`已创建 SQLite 数据库并新增连接「${created.name}」`, "ok");
      }
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
      title="新建数据库"
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
            <Database size={13} /> {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <div className="field-hint">
        在连接「{conn.name}」上{isMysql ? "新建一个 MySQL 数据库" : "创建一个新的 SQLite 数据库文件"}
      </div>

      {isMysql ? (
        <>
          <Field label="数据库名">
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 shop_dev"
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </Field>
          <Field label="字符集">
            <select className="select" value={charset} onChange={(e) => setCharset(e.target.value)}>
              <option value="utf8mb4">utf8mb4（推荐）</option>
              <option value="utf8">utf8</option>
              <option value="latin1">latin1</option>
              <option value="gbk">gbk</option>
            </select>
          </Field>
        </>
      ) : (
        <Field label="数据库文件" hint="文件不存在时会创建空库，并自动新增一个 SQLite 连接">
          <div className="row">
            <input
              className="input"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="C:\\data\\new.sqlite"
            />
            <button
              className="btn"
              onClick={async () => {
                const picked = await saveFile({
                  defaultPath: "new.sqlite",
                  filters: [{ name: "SQLite 数据库", extensions: ["sqlite", "db", "sqlite3"] }],
                });
                if (typeof picked === "string") setFilePath(picked);
              }}
            >
              <FolderOpen size={13} /> 浏览
            </button>
          </div>
        </Field>
      )}
    </Modal>
  );
}
