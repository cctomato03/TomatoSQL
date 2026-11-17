import { useEffect, useMemo, useState } from "react";
import { connectTo, openQuery, openTable } from "./actions";
import { newConnection, useStore } from "./store";
import type { Connection, Group } from "./types";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { ConfirmHost } from "./components/confirm";
import { ConnectionView } from "./components/ConnectionView";
import { ExportDialog, type ExportPreset } from "./components/ExportDialog";
import { GroupDialog } from "./components/GroupDialog";
import { ImportDialog, type ImportPreset } from "./components/ImportDialog";
import { QueryTab } from "./components/QueryTab";
import { SettingsDialog } from "./components/SettingsDialog";
import { CloudDialog } from "./components/CloudDialog";
import { SyncDialog } from "./components/SyncDialog";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TablePanel } from "./components/TablePanel";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import { Modal, Toasts } from "./components/ui";
import { getTheme } from "./themes";

export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const ws = useStore((s) => s.ws);
  const connected = useStore((s) => s.connected);

  const [connDialog, setConnDialog] = useState<{ conn?: Connection | null; groupId?: string | null } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ group?: Group | null; parentId?: string | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState<{ sourceConnId?: string } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [exportPreset, setExportPreset] = useState<ExportPreset | null>(null);
  const [importPreset, setImportPreset] = useState<ImportPreset | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  const tab = useMemo(() => tabs.find((t) => t.id === activeTab), [tabs, activeTab]);
  const connOf = (id?: string) => ws.connections.find((c) => c.id === id) ?? null;

  const openConnectionTabById = (connId?: string) => {
    const conn = connOf(connId);
    if (!conn) {
      return (
        <div className="empty">
          <div className="empty-title">连接不存在</div>
          <div className="empty-text">该连接可能已被删除。</div>
        </div>
      );
    }
    if (!connected[conn.id]) {
      return (
        <div className="empty">
          <div className="empty-title">{conn.name}</div>
          <div className="empty-text">连接尚未打开，点击下方按钮建立连接。</div>
          <button className="btn primary" onClick={() => void connectTo(conn)}>
            连接
          </button>
        </div>
      );
    }
    return (
      <ConnectionView
        conn={conn}
        engine={connected[conn.id]}
        onImport={(database, table) => setImportPreset({ connId: conn.id, database, table })}
        onSync={() => setSyncOpen({ sourceConnId: conn.id })}
      />
    );
  };

  const renderContent = () => {
    if (!ready) {
      return (
        <div className="empty">
          <div className="spinner" />
          <div className="empty-text">正在加载配置…</div>
        </div>
      );
    }
    if (!tab) return null;
    switch (tab.kind) {
      case "welcome":
        return (
          <Welcome
            onNewConnection={(kind) => setConnDialog({ conn: newConnection(kind), groupId: null })}
            onOpenCloud={() => setCloudOpen(true)}
            onOpenSync={() => setSyncOpen({})}
          />
        );
      case "connection":
        return openConnectionTabById(tab.connId);
      case "table": {
        const conn = connOf(tab.connId);
        if (!conn || !tab.database || !tab.table) {
          return (
            <div className="empty">
              <div className="empty-text">表信息缺失，请重新打开。</div>
            </div>
          );
        }
        return (
          <div className="content-panel" style={{ flex: 1 }}>
            <TablePanel
              conn={conn}
              database={tab.database}
              table={tab.table}
              onExport={() =>
                setExportPreset({ connId: conn.id, database: tab.database, tables: [tab.table!] })
              }
              onImport={() => setImportPreset({ connId: conn.id, database: tab.database, table: tab.table })}
            />
          </div>
        );
      }
      case "query": {
        const conn = connOf(tab.connId);
        if (!conn) {
          return (
            <div className="empty">
              <div className="empty-text">连接不存在。</div>
            </div>
          );
        }
        if (!connected[conn.id]) {
          return (
            <div className="empty">
              <div className="empty-title">{conn.name} 未连接</div>
              <button className="btn primary" onClick={() => void connectTo(conn)}>
                连接
              </button>
            </div>
          );
        }
        return <QueryTab tab={tab} conn={conn} onExport={(sql) => setExportPreset({ connId: conn.id, database: tab.database, sql })} />;
      }
      default:
        return null;
    }
  };

  const theme = getTheme(ws.settings.themeId);

  return (
    <div className="app">
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenCloud={() => setCloudOpen(true)}
        onOpenSync={() => setSyncOpen({})}
        onOpenAbout={() => setAboutOpen(true)}
      />

      <div className="body">
        <Sidebar
          onNewConnection={(kind, groupId) => {
            setConnDialog({ conn: { ...newConnection(kind), groupId }, groupId });
          }}
          onEditConnection={(conn) => setConnDialog({ conn })}
          onNewGroup={(parentId) => setGroupDialog({ group: null, parentId })}
          onEditGroup={(group) => setGroupDialog({ group })}
          onOpenTransfer={(conn) =>
            setExportPreset({ connId: conn.id, database: conn.database ?? "" })
          }
          onOpenSync={(sourceConnId) => setSyncOpen({ sourceConnId })}
          onOpenTable={(conn, database, table) => openTable(conn, database, table)}
          onOpenQuery={(conn, database, sql) => openQuery(conn, database, sql)}
          onImport={(conn, database, table) => setImportPreset({ connId: conn.id, database, table })}
        />

        <main className="main">
          <TabBar />
          <div className="tabcontent">{renderContent()}</div>
        </main>
      </div>

      <footer className="statusbar">
        <span className="statusbar-item">
          <span className={`dot ${Object.keys(connected).length ? "" : "off"}`} />
          {Object.keys(connected).length} 个连接已打开
        </span>
        <span className="statusbar-item">共 {ws.connections.length} 个连接</span>
        <span className="statusbar-item">主题：{theme.name}</span>
        <span className="statusbar-item">字号：{ws.settings.fontSize}px</span>
        <span className="grow" />
        {tab && <span className="statusbar-item">{tab.title}</span>}
        <span className="statusbar-item">TomatoSQL v1.0.0</span>
      </footer>

      <Toasts />
      <ConfirmHost />

      {connDialog && (
        <ConnectionDialog
          conn={connDialog.conn}
          groupId={connDialog.groupId}
          onClose={() => setConnDialog(null)}
        />
      )}
      {groupDialog && (
        <GroupDialog
          group={groupDialog.group}
          parentId={groupDialog.parentId}
          onClose={() => setGroupDialog(null)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {cloudOpen && <CloudDialog onClose={() => setCloudOpen(false)} />}
      {syncOpen && <SyncDialog sourceConnId={syncOpen.sourceConnId} onClose={() => setSyncOpen(null)} />}
      {aboutOpen && (
        <Modal title="关于 TomatoSQL" size="sm" onClose={() => setAboutOpen(false)}>
          <div className="field-hint" style={{ lineHeight: 1.9 }}>
            TomatoSQL 1.0.0 · Tauri 2 + React 19 + Rust
            <br />
            跨平台数据库管理工具，支持 MySQL / SQLite、导入导出、结构同步与端到端加密云同步。
          </div>
        </Modal>
      )}
      {exportPreset && (
        <ExportDialog preset={exportPreset} onClose={() => setExportPreset(null)} />
      )}
      {importPreset && <ImportDialog preset={importPreset} onClose={() => setImportPreset(null)} />}
    </div>
  );
}
