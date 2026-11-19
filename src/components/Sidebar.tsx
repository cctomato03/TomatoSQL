import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Copy,
  Database,
  FolderPlus,
  Import,
  FileCode2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
  Search,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { useStore } from "../store";
import type { Connection, Group } from "../types";
import { connectTo, disconnectFrom, openConnectionView } from "../actions";
import { ConnectionExplorer } from "./ConnectionExplorer";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
import { confirmDialog } from "./confirm";
import { ContextMenu, type MenuItemSpec } from "./ui";

interface Props {
  onNewConnection: (kind: "mysql" | "sqlite", groupId: string | null) => void;
  onEditConnection: (conn: Connection) => void;
  onNewGroup: (parentId: string | null) => void;
  onEditGroup: (group: Group) => void;
  onOpenTransfer: (conn: Connection) => void;
  onOpenSync: (sourceConnId?: string) => void;
  onOpenTable: (conn: Connection, database: string, table: string) => void;
  onOpenQuery: (conn: Connection, database: string, sql?: string) => void;
  onImport: (conn: Connection, database: string, table?: string) => void;
  onRunSqlFile: (conn: Connection) => void;
}

export function Sidebar({
  onNewConnection,
  onEditConnection,
  onNewGroup,
  onEditGroup,
  onOpenTransfer,
  onOpenSync,
  onOpenTable,
  onOpenQuery,
  onImport,
  onRunSqlFile,
}: Props) {
  const ws = useStore((s) => s.ws);
  const connected = useStore((s) => s.connected);
  const busy = useStore((s) => s.busy);
  const selectedConnId = useStore((s) => s.selectedConnId);
  const selectConn = useStore((s) => s.selectConn);
  const upsertGroup = useStore((s) => s.upsertGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const removeConnection = useStore((s) => s.removeConnection);
  const notify = useStore((s) => s.notify);

  // 连接被断开（不管是点插头、右键断开，还是关闭数据库导致的断开）时，
  // 自动收起该节点，避免再次双击时被当成"收起"而不是重连
  useEffect(() => {
    setExpandedConns((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!connected[id]) {
          next[id] = false;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [connected]);

  const [filter, setFilter] = useState("");
  const [expandedConns, setExpandedConns] = useState<Record<string, boolean>>({});
  const [createDbConn, setCreateDbConn] = useState<Connection | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItemSpec[];
  } | null>(null);

  const groups = useMemo(
    () => [...ws.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [ws.groups],
  );
  const connections = useMemo(() => {
    const list = [...ws.connections].sort((a, b) => a.name.localeCompare(b.name));
    const kw = filter.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((c) => {
      const hay = `${c.name} ${c.host ?? ""} ${c.file ?? ""} ${c.database ?? ""}`.toLowerCase();
      return hay.includes(kw);
    });
  }, [ws.connections, filter]);

  const childrenOf = (groupId: string | null) =>
    connections.filter((c) => (c.groupId ?? null) === groupId);

  const openMenu = (e: React.MouseEvent, items: MenuItemSpec[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const editCopyDelete = (conn: Connection): MenuItemSpec[] => [
    { label: "编辑连接", icon: <Pencil size={13} />, onClick: () => onEditConnection(conn) },
    {
      label: "复制连接",
      icon: <Copy size={13} />,
      onClick: () => {
        const copy: Connection = {
          ...conn,
          id: `copy-${Date.now().toString(36)}`,
          name: `${conn.name} 副本`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        useStore.getState().upsertConnection(copy);
      },
    },
    {
      label: "删除连接",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => {
        void (async () => {
          if (
            useStore.getState().ws.settings.confirmDestructive &&
            !(await confirmDialog({
              title: "删除连接",
              message: `确定删除连接「${conn.name}」？该操作不可撤销。`,
            }))
          ) {
            return;
          }
          removeConnection(conn.id);
          notify(`已删除连接 ${conn.name}`, "ok");
        })();
      },
    },
  ];

  /** 连接右键菜单：打开时→新建数据库 / 运行 SQL 文件 / 断开 / 编辑复制删除；关闭时→仅编辑、复制、删除 */
  const connMenu = (conn: Connection): MenuItemSpec[] => {
    if (!connected[conn.id]) return editCopyDelete(conn);
    return [
      {
        label: "新建数据库",
        icon: <Database size={13} />,
        onClick: () => setCreateDbConn(conn),
      },
      {
        label: "运行 SQL 文件…",
        icon: <FileCode2 size={13} />,
        onClick: () => onRunSqlFile(conn),
      },
      { separator: true, label: "sep1" },
      {
        label: "断开连接",
        icon: <Unplug size={13} />,
        onClick: () => void disconnectFrom(conn.id),
      },
      { separator: true, label: "sep2" },
      ...editCopyDelete(conn),
    ];
  };

  const groupMenu = (group: Group): MenuItemSpec[] => [
    {
      label: "在此分组新建 MySQL 连接",
      icon: <Plus size={13} />,
      onClick: () => onNewConnection("mysql", group.id),
    },
    {
      label: "在此分组新建 SQLite 连接",
      icon: <Plus size={13} />,
      onClick: () => onNewConnection("sqlite", group.id),
    },
    { label: "新建子分组", icon: <FolderPlus size={13} />, onClick: () => onNewGroup(group.id) },
    { separator: true, label: "sep1" },
    { label: "重命名分组", icon: <Pencil size={13} />, onClick: () => onEditGroup(group) },
    {
      label: "删除分组",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => {
        void (async () => {
          const count = ws.connections.filter((c) => c.groupId === group.id).length;
          const message = count
            ? `分组「${group.name}」下有 ${count} 个连接。确定删除分组并保留连接（移到根目录）？`
            : `确定删除分组「${group.name}」？`;
          const needConfirm = useStore.getState().ws.settings.confirmDestructive;
          if (!needConfirm || (await confirmDialog({ title: "删除分组", message }))) {
            removeGroup(group.id, false);
            notify("已删除分组", "ok");
          }
        })();
      },
    },
  ];

  /** 展开连接节点：未连接时先建立连接，再展示库/表 */
  const toggleConn = async (conn: Connection) => {
    const isOpen = Boolean(expandedConns[conn.id]);
    if (isOpen) {
      setExpandedConns((s) => ({ ...s, [conn.id]: false }));
      return;
    }
    if (!connected[conn.id]) {
      const ok = await connectTo(conn, false);
      if (!ok) return;
    }
    setExpandedConns((s) => ({ ...s, [conn.id]: true }));
  };

  const renderConn = (conn: Connection) => {
    const isOn = Boolean(connected[conn.id]);
    const isBusy = busy[`conn:${conn.id}`];
    const isOpen = Boolean(expandedConns[conn.id]);
    return (
      <div key={conn.id}>
        <div
          className={`tree-row ${selectedConnId === conn.id ? "selected" : ""}`}
          onClick={() => selectConn(conn.id)}
          onDoubleClick={() => void toggleConn(conn)}
          onContextMenu={(e) => openMenu(e, connMenu(conn))}
          title={`${conn.name}${conn.kind === "sqlite" ? ` · ${conn.file ?? ""}` : ` · ${conn.host ?? ""}:${conn.port ?? 3306}`}（双击展开/收起数据库）`}
        >
          <span className={`obj-chev ${isOpen ? "open" : ""}`} style={{ width: "0.8rem" }}>
            <ChevronRight size={12} />
          </span>
          <span className={`conn-dot ${isOn ? "on" : "off"}`} />
          <span className="tree-label">{conn.name}</span>
          <span className="kind-tag">{conn.kind === "mysql" ? "MY" : "SQ"}</span>
          <button
            className="tree-toggle"
            title="新建查询"
            onClick={(e) => {
              e.stopPropagation();
              onOpenQuery(conn, "", "");
            }}
          >
            <TerminalSquare size={13} />
          </button>
          <button
            className="tree-toggle"
            title={isOn ? "断开连接" : "连接"}
            onClick={(e) => {
              e.stopPropagation();
              void (async () => {
                if (isOn) {
                  await disconnectFrom(conn.id);
                  setExpandedConns((s) => ({ ...s, [conn.id]: false }));
                } else {
                  const ok = await connectTo(conn, false);
                  if (ok) setExpandedConns((s) => ({ ...s, [conn.id]: true }));
                }
              })();
            }}
          >
            {isBusy ? <div className="spinner" style={{ width: "0.8rem", height: "0.8rem" }} /> : null}
            {!isBusy && (isOn ? <Unplug size={13} /> : <Plug size={13} />)}
          </button>
        </div>

        {isOpen && (
          <ConnectionExplorer
            conn={conn}
            onOpenTable={(db, t) => onOpenTable(conn, db, t)}
            onOpenQuery={(db, sql) => onOpenQuery(conn, db, sql)}
    
          />
        )}
      </div>
    );
  };

  const renderGroupTree = (parentId: string | null, depth: number): React.ReactNode => {
    const children = groups.filter((g) => (g.parentId ?? null) === parentId);
    if (!children.length) return null;
    return children.map((g) => (
      <div className="tree-group" key={g.id}>
        <div
          className="tree-row"
          onClick={() => upsertGroup({ ...g, expanded: !g.expanded })}
          onContextMenu={(e) => openMenu(e, groupMenu(g))}
          onDoubleClick={() => onEditGroup(g)}
        >
          <span className={`chev ${g.expanded ? "open" : ""}`}>
            <ChevronRight size={13} />
          </span>
          <Database size={13} color={g.color ?? "var(--text-3)"} />
          <span className="tree-label">{g.name}</span>
          <span className="tree-meta">
            {(ws.connections.filter((c) => c.groupId === g.id).length || 0) || ""}
          </span>
        </div>
        {g.expanded && (
          <div className="tree-children" style={{ marginLeft: depth > 0 ? "0.6rem" : undefined }}>
            {childrenOf(g.id).map(renderConn)}
            {renderGroupTree(g.id, depth + 1)}
          </div>
        )}
      </div>
    ));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">连接</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.15rem" }}>
          <button className="icon-btn" title="新建 MySQL 连接" onClick={() => onNewConnection("mysql", null)}>
            <Plus size={15} />
          </button>
          <button className="icon-btn" title="新建 SQLite 连接" onClick={() => onNewConnection("sqlite", null)}>
            <Server size={15} />
          </button>
          <button className="icon-btn" title="新建分组" onClick={() => onNewGroup(null)}>
            <FolderPlus size={15} />
          </button>
          <button
            className="icon-btn"
            title="结构同步 / 数据迁移"
            onClick={() => onOpenSync(selectedConnId ?? undefined)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div style={{ padding: "0.35rem 0.5rem" }}>
        <div style={{ position: "relative" }}>
          <Search
            size={13}
            style={{
              position: "absolute",
              left: "0.45rem",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-3)",
            }}
          />
          <input
            className="input"
            style={{ paddingLeft: "1.6rem", height: "1.7rem" }}
            placeholder="搜索连接"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div
        className="sidebar-scroll"
        onContextMenu={(e) =>
          openMenu(e, [
            { label: "新建 MySQL 连接", icon: <Plus size={13} />, onClick: () => onNewConnection("mysql", null) },
            { label: "新建 SQLite 连接", icon: <Plus size={13} />, onClick: () => onNewConnection("sqlite", null) },
            { label: "新建分组", icon: <FolderPlus size={13} />, onClick: () => onNewGroup(null) },
          ])
        }
      >
        {renderGroupTree(null, 0)}
        {connections
          .filter((c) => !c.groupId || !ws.groups.some((g) => g.id === c.groupId))
          .map(renderConn)}
        {!ws.connections.length && (
          <div style={{ padding: "1rem 0.6rem", color: "var(--text-3)", fontSize: "0.88rem", lineHeight: 1.7 }}>
            还没有连接。点击右上角 <Plus size={12} style={{ verticalAlign: "-2px" }} /> 新建 MySQL
            连接，或用 <Server size={12} style={{ verticalAlign: "-2px" }} /> 打开 SQLite 文件。
          </div>
        )}
      </div>

      <div style={{ padding: "0.4rem 0.5rem", borderTop: "1px solid var(--border)", display: "flex", gap: "0.3rem" }}>
        <button
          className="btn sm grow"
          disabled={!selectedConnId}
          onClick={() => {
            const conn = ws.connections.find((c) => c.id === selectedConnId);
            if (conn) onOpenTransfer(conn);
          }}
          title="导入 / 导出"
        >
          <Upload size={13} /> 传输
        </button>
        <button
          className="btn sm grow"
          disabled={!selectedConnId}
          onClick={() => {
            const conn = ws.connections.find((c) => c.id === selectedConnId);
            if (conn) void connectTo(conn).then(() => openConnectionView(conn));
          }}
          title="打开连接"
        >
          <Plug size={13} /> 打开
        </button>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {createDbConn && (
        <CreateDatabaseDialog
          conn={createDbConn}
          onClose={() => setCreateDbConn(null)}
          onDone={() => setExpandedConns((s) => ({ ...s, [createDbConn.id]: true }))}
        />
      )}
    </aside>
  );
}
