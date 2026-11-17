import { useEffect, useState } from "react";
import { Cloud, CloudDownload, CloudUpload, KeyRound, LogIn, UserPlus, Wifi } from "lucide-react";
import { cloud, decryptPayload, encryptPayload, hasCrypto, type Envelope } from "../cloud";
import { useStore } from "../store";
import type { Connection, Group, Workspace } from "../types";
import { confirmDialog } from "./confirm";
import { Field, Modal } from "./ui";

type Payload = { version: number; groups: Group[]; connections: Connection[]; updatedAt: number };

function mergeById<T extends { id: string; updatedAt?: number }>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of local) map.set(item.id, item);
  for (const item of remote) {
    const existing = map.get(item.id);
    if (!existing) map.set(item.id, item);
    else if ((item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) map.set(item.id, item);
  }
  return [...map.values()];
}

export function CloudDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.ws.settings);
  const ws = useStore((s) => s.ws);
  const setSettings = useStore((s) => s.setSettings);
  const replaceWorkspace = useStore((s) => s.replaceWorkspace);
  const notify = useStore((s) => s.notify);

  const [serverUrl, setServerUrl] = useState(settings.cloud.serverUrl ?? "");
  const [username, setUsername] = useState(settings.cloud.username ?? "");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(settings.cloud.token ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [remoteInfo, setRemoteInfo] = useState<{ blobUpdatedAt: number | null; blobBytes: number } | null>(null);

  const cryptoOk = hasCrypto();

  const saveCloud = (patch: Partial<typeof settings.cloud>) => {
    setSettings({ cloud: { ...settings.cloud, ...patch } });
  };

  const report = (ok: boolean, text: string) => {
    setMessage({ ok, text });
    if (!ok) notify(text, "err");
  };

  const refreshInfo = async (tk: string, base: string) => {
    try {
      const me = await cloud.me(base, tk);
      setRemoteInfo({ blobUpdatedAt: me.blobUpdatedAt, blobBytes: me.blobBytes });
    } catch {
      setRemoteInfo(null);
    }
  };

  useEffect(() => {
    if (token && serverUrl) void refreshInfo(token, serverUrl);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doHealth = async () => {
    setBusy("health");
    setMessage(null);
    try {
      const r = await cloud.health(serverUrl);
      report(true, `服务器可用（版本 ${r.version}）`);
      saveCloud({ serverUrl });
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
    }
  };

  const doAuth = async (mode: "register" | "login") => {
    setBusy(mode);
    setMessage(null);
    try {
      if (!username.trim() || password.length < 6) {
        throw new Error("请填写用户名与至少 6 位密码");
      }
      const acc =
        mode === "register"
          ? await cloud.register(serverUrl, username.trim(), password)
          : await cloud.login(serverUrl, username.trim(), password);
      setToken(acc.token);
      saveCloud({ serverUrl, username: username.trim(), token: acc.token });
      report(true, mode === "register" ? "注册并登录成功" : "登录成功");
      await refreshInfo(acc.token, serverUrl);
      setPassword("");
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    setBusy("push");
    setMessage(null);
    try {
      if (!passphrase) throw new Error("请先设置同步口令（用于端到端加密）");
      const payload: Payload = {
        version: ws.version,
        groups: ws.groups,
        connections: ws.connections,
        updatedAt: Date.now(),
      };
      const env = await encryptPayload(passphrase, payload);
      env.itemCount = ws.connections.length;
      await cloud.push(serverUrl, token, env);
      saveCloud({ lastSyncAt: Date.now(), username, serverUrl });
      report(true, `已上传 ${ws.connections.length} 个连接（端到端加密）`);
      await refreshInfo(token, serverUrl);
    } catch (e) {
      report(false, String(e));
    } finally {
      setBusy(null);
    }
  };

  const pull = async (mode: "overwrite" | "merge") => {
    setBusy(mode);
    setMessage(null);
    try {
      if (!passphrase) throw new Error("请先输入同步口令");
      const res = await cloud.pull(serverUrl, token);
      if (!res.payload) throw new Error("云端暂无数据，请先上传一次");
      const remote = await decryptPayload<Payload>(passphrase, res.payload as Envelope);
      if (mode === "overwrite") {
        const next: Workspace = {
          ...ws,
          version: remote.version ?? 1,
          groups: remote.groups ?? [],
          connections: remote.connections ?? [],
          updatedAt: remote.updatedAt ?? Date.now(),
        };
        replaceWorkspace(next);
        report(true, `已从云端恢复 ${next.connections.length} 个连接`);
      } else {
        const groups = mergeById(ws.groups, remote.groups ?? []);
        const connections = mergeById(ws.connections, remote.connections ?? []);
        replaceWorkspace({ ...ws, groups, connections, updatedAt: Date.now() });
        report(true, `合并完成：本地 ${ws.connections.length} + 云端 ${(remote.connections ?? []).length} → 共 ${connections.length} 个连接`);
      }
      saveCloud({ lastSyncAt: Date.now() });
    } catch (e) {
      report(
        false,
        String(e).includes("operation failed")
          ? "解密失败：同步口令不正确，或云端数据不属于该口令"
          : String(e),
      );
    } finally {
      setBusy(null);
    }
  };

  const lastSync = settings.cloud.lastSyncAt
    ? new Date(settings.cloud.lastSyncAt).toLocaleString()
    : "从未同步";

  return (
    <Modal
      title="云同步"
      onClose={onClose}
      footer={
        <>
          <span className="left">
            {message && (
              <span style={{ color: message.ok ? "var(--success)" : "var(--danger)" }}>{message.text}</span>
            )}
          </span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {!cryptoOk && (
        <div className="msg-line err">当前运行环境不支持 WebCrypto，无法进行端到端加密同步。</div>
      )}

      <div className="form-grid">
        <Field label="服务器地址" hint="自建 Docker 服务地址，例如 https://sync.example.com" full>
          <div className="row">
            <input
              className="input"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://sync.example.com"
            />
            <button className="btn" onClick={() => void doHealth()} disabled={busy === "health" || !serverUrl}>
              <Wifi size={13} /> 测试
            </button>
          </div>
        </Field>

        <Field label="用户名">
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="仅用于云端账号"
          />
        </Field>
        <Field label="登录密码">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
          />
        </Field>

        <Field
          label="同步口令（端到端加密）"
          hint="用于加密连接信息，服务器无法解密。请自行牢记，忘记则云端数据无法恢复。"
          full
        >
          <div style={{ position: "relative" }}>
            <input
              className="input"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="设置一个强口令，例如 20 位随机字符"
              style={{ paddingLeft: "1.9rem" }}
            />
            <KeyRound
              size={13}
              style={{ position: "absolute", left: "0.5rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-3)" }}
            />
          </div>
        </Field>
      </div>

      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void doAuth("register")} disabled={Boolean(busy) || !serverUrl}>
          <UserPlus size={13} /> {busy === "register" ? "注册中…" : "注册并登录"}
        </button>
        <button className="btn" onClick={() => void doAuth("login")} disabled={Boolean(busy) || !serverUrl}>
          <LogIn size={13} /> {busy === "login" ? "登录中…" : "登录"}
        </button>
        <span className="grow" />
        {token ? <span className="badge ok">已登录 {settings.cloud.username || username}</span> : <span className="badge">未登录</span>}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.7rem" }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            className="btn primary"
            onClick={() => void upload()}
            disabled={!token || !passphrase || Boolean(busy)}
          >
            <CloudUpload size={13} /> {busy === "push" ? "上传中…" : "上传本地配置到云端"}
          </button>
          <button
            className="btn"
            onClick={() => void pull("merge")}
            disabled={!token || !passphrase || Boolean(busy)}
          >
            <Cloud size={13} /> {busy === "merge" ? "合并中…" : "智能合并云端"}
          </button>
          <button
            className="btn"
            onClick={() => {
              void (async () => {
                const needConfirm = useStore.getState().ws.settings.confirmDestructive;
                const ok =
                  !needConfirm ||
                  (await confirmDialog({
                    title: "从云端覆盖恢复",
                    message: "云端配置会覆盖当前本地连接配置，确定继续？",
                  }));
                if (ok) void pull("overwrite");
              })();
            }}
            disabled={!token || !passphrase || Boolean(busy)}
          >
            <CloudDownload size={13} /> {busy === "overwrite" ? "恢复中…" : "从云端覆盖恢复"}
          </button>
        </div>
      </div>

      <div className="field-hint" style={{ lineHeight: 1.9 }}>
        最近同步：{lastSync}
        {remoteInfo?.blobUpdatedAt ? ` · 云端更新于 ${new Date(remoteInfo.blobUpdatedAt).toLocaleString()}` : ""}
        {remoteInfo?.blobBytes ? ` · ${(remoteInfo.blobBytes / 1024).toFixed(1)} KB` : ""}
        <br />
        仅同步「连接与分组」，不同步任何数据库里的业务数据。密码随连接一起加密上传，换机后用同一口令即可恢复。
      </div>
    </Modal>
  );
}
