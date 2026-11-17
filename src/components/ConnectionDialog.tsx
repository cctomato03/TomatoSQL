import { useState } from "react";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff, FolderOpen, Save, Wifi } from "lucide-react";
import { api } from "../api";
import { newConnection, useStore } from "../store";
import type { Connection } from "../types";
import { Field, Modal, Segmented } from "./ui";

export function ConnectionDialog({
  conn,
  groupId,
  onClose,
}: {
  conn?: Connection | null;
  groupId?: string | null;
  onClose: () => void;
}) {
  const upsert = useStore((s) => s.upsertConnection);
  const notify = useStore((s) => s.notify);
  const groups = useStore((s) => s.ws.groups);
  const [draft, setDraft] = useState<Connection>(
    conn ?? { ...newConnection("mysql"), groupId: groupId ?? null },
  );
  const [showPwd, setShowPwd] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const patch = (p: Partial<Connection>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTestMsg(null);
  };

  const switchKind = (kind: "mysql" | "sqlite") => {
    const base = newConnection(kind);
    setDraft({ ...base, id: draft.id, name: draft.name, groupId: draft.groupId });
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await api.testConnection(draft);
      setTestMsg({
        ok: r.ok,
        text: r.ok
          ? `连接成功${r.version ? `：${r.version}` : ""}（${r.latencyMs}ms）`
          : r.message,
      });
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const submit = () => {
    if (!draft.name.trim()) {
      notify("请填写连接名称", "err");
      return;
    }
    if (draft.kind === "sqlite" && !draft.file) {
      notify("请选择 SQLite 数据库文件", "err");
      return;
    }
    upsert({ ...draft, name: draft.name.trim() });
    notify(`已保存连接 ${draft.name}`, "ok");
    onClose();
  };

  return (
    <Modal
      title={conn ? "编辑连接" : "新建连接"}
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {testMsg && (
              <span style={{ color: testMsg.ok ? "var(--success)" : "var(--danger)" }}>
                {testMsg.text}
              </span>
            )}
          </span>
          <button className="btn" onClick={() => void test()} disabled={testing}>
            <Wifi size={13} /> {testing ? "测试中…" : "测试连接"}
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            保存
          </button>
        </>
      }
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Segmented
          value={draft.kind}
          onChange={(v) => switchKind(v)}
          options={[
            { value: "mysql", label: "MySQL" },
            { value: "sqlite", label: "SQLite" },
          ]}
        />
        <span className="field-hint">密码使用本地密钥加密保存，不上传到任何服务器</span>
      </div>

      <div className="form-grid">
        <Field label="连接名称" full>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如：生产库 / 本地测试"
          />
        </Field>

        <Field label="分组">
          <select
            className="select"
            value={draft.groupId ?? ""}
            onChange={(e) => patch({ groupId: e.target.value || null })}
          >
            <option value="">（未分组）</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>

        {draft.kind === "mysql" ? (
          <>
            <Field label="字符集">
              <input
                className="input"
                value={draft.charset ?? ""}
                onChange={(e) => patch({ charset: e.target.value })}
                placeholder="utf8mb4"
              />
            </Field>
            <Field label="主机">
              <input
                className="input"
                value={draft.host ?? ""}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </Field>
            <Field label="端口">
              <input
                className="input"
                type="number"
                value={draft.port ?? 3306}
                onChange={(e) => patch({ port: Number(e.target.value) })}
              />
            </Field>
            <Field label="用户名">
              <input
                className="input"
                value={draft.user ?? ""}
                onChange={(e) => patch({ user: e.target.value })}
                placeholder="root"
              />
            </Field>
            <Field label="密码">
              <div style={{ position: "relative" }}>
                <input
                  className="input"
                  style={{ paddingRight: "2rem" }}
                  type={showPwd ? "text" : "password"}
                  value={draft.password ?? ""}
                  onChange={(e) => patch({ password: e.target.value })}
                />
                <button
                  className="icon-btn"
                  style={{ position: "absolute", right: 0, top: 0, width: "1.9rem", height: "1.9rem" }}
                  onClick={() => setShowPwd((v) => !v)}
                  title={showPwd ? "隐藏密码" : "显示密码"}
                  type="button"
                >
                  {showPwd ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </Field>
            <Field label="默认数据库">
              <input
                className="input"
                value={draft.database ?? ""}
                onChange={(e) => patch({ database: e.target.value })}
                placeholder="可留空"
              />
            </Field>
            <Field label="SSL 模式">
              <select
                className="select"
                value={draft.sslMode ?? "disabled"}
                onChange={(e) => patch({ sslMode: e.target.value })}
              >
                <option value="disabled">禁用</option>
                <option value="preferred">优先使用</option>
                <option value="required">必须使用</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="数据库文件" full>
              <div className="row">
                <input
                  className="input"
                  value={draft.file ?? ""}
                  onChange={(e) => patch({ file: e.target.value })}
                  placeholder="C:\\data\\mydb.sqlite"
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await openFile({
                      multiple: false,
                      filters: [
                        { name: "SQLite 数据库", extensions: ["sqlite", "sqlite3", "db", "db3"] },
                        { name: "全部文件", extensions: ["*"] },
                      ],
                    });
                    if (typeof picked === "string") patch({ file: picked });
                  }}
                >
                  <FolderOpen size={13} /> 浏览
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const target = await saveFile({
                      defaultPath: "new.sqlite",
                      filters: [{ name: "SQLite 数据库", extensions: ["sqlite", "db"] }],
                    });
                    if (typeof target === "string") patch({ file: target });
                  }}
                  title="新建一个 SQLite 数据库文件"
                >
                  <Save size={13} /> 新建
                </button>
              </div>
            </Field>
            <Field label="只读打开" full>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(draft.readOnly)}
                  onChange={(e) => patch({ readOnly: e.target.checked })}
                />
                <span>以只读方式打开，防止误写</span>
              </label>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
