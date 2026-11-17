import { useState } from "react";
import { Check, FolderOpen } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { THEMES } from "../themes";
import { Checkbox, Field, Modal } from "./ui";

type Tab = "appearance" | "data" | "about";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.ws.settings);
  const setSettings = useStore((s) => s.setSettings);
  const info = useStore((s) => s.info);
  const [tab, setTab] = useState<Tab>("appearance");

  const preview = (id: string) => {
    const t = THEMES.find((x) => x.id === id)!;
    return (
      <div className="theme-preview" style={{ background: t.vars["--bg"] }}>
        <div className="tp-side" style={{ background: t.vars["--bg-2"], borderColor: t.vars["--border"] }} />
        <div className="tp-main">
          <div className="tp-bar" style={{ background: t.vars["--bg-2"], borderColor: t.vars["--border"] }} />
          <div style={{ padding: "0.3rem", display: "flex", gap: "0.2rem", alignItems: "center" }}>
            <span
              style={{
                width: "0.75rem",
                height: "0.75rem",
                borderRadius: "0.2rem",
                background: t.vars["--accent"],
              }}
            />
            <span style={{ height: "0.3rem", flex: 1, background: t.vars["--border"], borderRadius: 2 }} />
          </div>
          <div style={{ padding: "0 0.3rem", display: "flex", flexDirection: "column", gap: "0.18rem" }}>
            <span style={{ height: "0.22rem", width: "80%", background: t.vars["--text-3"], borderRadius: 2, opacity: 0.6 }} />
            <span style={{ height: "0.22rem", width: "60%", background: t.vars["--text-3"], borderRadius: 2, opacity: 0.4 }} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal
      title="设置"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            设置即时生效，并自动保存到本地（{info?.dataDir ?? "—"}）
          </span>
          <button className="btn primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: "0.2rem" }}>
        <button className={`subtab ${tab === "appearance" ? "active" : ""}`} onClick={() => setTab("appearance")}>
          外观
        </button>
        <button className={`subtab ${tab === "data" ? "active" : ""}`} onClick={() => setTab("data")}>
          数据与编辑器
        </button>
        <button className={`subtab ${tab === "about" ? "active" : ""}`} onClick={() => setTab("about")}>
          关于
        </button>
      </div>

      {tab === "appearance" && (
        <>
          <Field label="主题" hint="点击立即切换，8 套内置主题可自由搭配浅色/深色使用场景。">
            <div className="theme-grid">
              {THEMES.map((t) => (
                <div
                  key={t.id}
                  className={`theme-card ${settings.themeId === t.id ? "active" : ""}`}
                  onClick={() => setSettings({ themeId: t.id })}
                >
                  {preview(t.id)}
                  <div className="theme-name">
                    {settings.themeId === t.id && <Check size={12} color="var(--accent)" />}
                    {t.name}
                    <span className="badge" style={{ marginLeft: "auto", fontSize: "0.7rem" }}>
                      {t.dark ? "深" : "浅"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Field>

          <div className="form-grid">
            <Field label={`界面字号：${settings.fontSize}px`} hint="影响整站文字、行高与控件尺寸">
              <input
                type="range"
                min={11}
                max={18}
                step={1}
                value={settings.fontSize}
                onChange={(e) => setSettings({ fontSize: Number(e.target.value) })}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
            </Field>
            <Field label={`SQL 编辑器字号：${settings.editorFontSize}px`}>
              <input
                type="range"
                min={11}
                max={22}
                step={1}
                value={settings.editorFontSize}
                onChange={(e) => setSettings({ editorFontSize: Number(e.target.value) })}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
            </Field>
          </div>
        </>
      )}

      {tab === "data" && (
        <>
          <div className="form-grid">
            <Field label="每页读取行数" hint="浏览表数据时的默认分页大小">
              <select
                className="select"
                value={settings.pageSize}
                onChange={(e) => setSettings({ pageSize: Number(e.target.value) })}
              >
                {[100, 200, 500, 1000, 2000].map((n) => (
                  <option key={n} value={n}>
                    {n} 行
                  </option>
                ))}
              </select>
            </Field>
            <Field label="查询结果上限" hint="SQL 编辑器单次返回的最大行数（可在编辑器内调整）">
              <input className="input" value="1000 / 5000 / 20000 / 100000" readOnly />
            </Field>
          </div>

          <div className="col" style={{ gap: "0.5rem" }}>
            <Checkbox
              checked={settings.showLineNumbers}
              onChange={(v) => setSettings({ showLineNumbers: v })}
              label="SQL 编辑器显示行号"
            />
            <Checkbox
              checked={settings.confirmDestructive}
              onChange={(v) => setSettings({ confirmDestructive: v })}
              label="删除连接、分组等危险操作前需要确认"
            />
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.7rem" }}>
            <div className="field-label" style={{ marginBottom: "0.35rem" }}>
              本地数据
            </div>
            <div className="field-hint" style={{ marginBottom: "0.5rem" }}>
              连接配置、分组与设置保存在 <span className="mono">{info?.dataDir ?? "—"}/workspace.json</span>
              ，密码使用 AES-256-GCM 与设备本地密钥加密。
            </div>
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  if (info?.dataDir) {
                    import("@tauri-apps/plugin-opener")
                      .then((m) => m.revealItemInDir(`${info.dataDir}/workspace.json`))
                      .catch(() => void 0);
                  }
                }}
              >
                <FolderOpen size={13} /> 打开数据目录
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const ws = await api.loadWorkspace();
                  const text = JSON.stringify(ws, null, 2);
                  await navigator.clipboard.writeText(text).catch(() => void 0);
                  useStore.getState().notify("已复制配置 JSON 到剪贴板（含加密后的密码）", "ok");
                }}
              >
                复制配置 JSON
              </button>
            </div>
          </div>
        </>
      )}

      {tab === "about" && (
        <div className="col" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ gap: "0.6rem" }}>
            <div className="brand-logo" style={{ width: "2.2rem", height: "2.2rem", fontSize: "1rem" }}>
              T
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>TomatoSQL {info?.version}</div>
              <div className="field-hint">
                {info?.platform} · {info?.arch}
              </div>
            </div>
          </div>
          <div className="field-hint" style={{ lineHeight: 1.9 }}>
            基于 Tauri 2 + React 19 + Rust 构建的跨平台数据库管理工具，支持 MySQL 与 SQLite。
            <br />
            功能：连接与分组管理、SQL 编辑器、数据浏览与编辑、CSV/JSON/SQL 导入导出、结构比较与同步、
            多主题与字号设置、自建服务的端到端加密云同步。
          </div>
        </div>
      )}
    </Modal>
  );
}
