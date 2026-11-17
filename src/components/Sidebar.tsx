import { useMemo, useState } from "react";
import {
  ChevronRight,
  Copy,
  Database,
  FolderPlus,
  Import,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
  Search,
  Upload,
} from "lucide-react";
import { useStore } from "../store";
import type { Connection, Group } from "../types";
import { connectTo, disconnectFrom, openConnectionView } from "../actions";
import { ContextMenu, type MenuItemSpec } from "./ui";

interface Props {
  onNewConnection: (kind: "mysql" | "sqlite", groupId: string | null) => void;
  onEditConnection: (conn: Connection) => void;
  onNewGroup: (parentId: string | null) => void;
  onEditGroup: (group: Group) => void;
  onOpenTransfer: (conn: Connection) => void;
  onOpenSync: (sourceConnId?: string) => void;
}

export function Sidebar({
  onNewConnection,
  onEditConnection,
  onNewGroup,
  onEditGroup,
  onOpenTransfer,
  onOpenSync,
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

  const [filter, setFilter] = useState("");
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

  const connMenu = (conn: Connection): MenuItemSpec[] => [
    {
      label: connected[conn.id] ? "打开" : "连接并打开",
      icon: <Plug size={13} />,
      onClick: () => void connectTo(conn),
    },
    ...(connected[conn.id]
      ? [
          {
            label: "断开连接",
            icon: <Unplug size={13} />,
            onClick: () => void disconnectFrom(conn.id),
          },
        ]
      : []),
    { separator: true, label: "sep1" },
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
    { separator: true, label: "sep2" },
    { label: "导入 / 导出", icon: <Import size={13} />, onClick: () => onOpenTransfer(conn) },
    { label: "结构同步 / 迁移", icon: <RefreshCw size={13} />, onClick: () => onOpenSync(conn.id) },
    { separator: true, label: "sep3" },
    {
      label: "删除连接",
      icon: <Trash2 size={13} />,
      danger: true,
      onClick: () => {
        if (
          !useStore.getState().ws.settings.confirmDestructive ||
          window.confirm(`确定删除连接「${conn.name}」？该操作不可撤销。`)
        ) {
          removeConnection(conn.id);
          notify(`已删除连接 ${conn.name}`, "ok");
        }
      },
    },
  ];

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
        const count = ws.connections.filter((c) => c.groupId === group.id).length;
        const msg = count
          ? `分组「${group.name}」下有 ${count} 个连接。点击“确定”删除分组并保留连接（移到根目录）。`
          : `确定删除分组「${group.name}」？`;
        if (!useStore.getState().ws.settings.confirmDestructive || window.confirm(msg)) {
          removeGroup(group.id, false);
          notify("已删除分组", "ok");
        }
      },
    },
  ];

  const renderConn = (conn: Connection) => {
    const isOn = Boolean(connected[conn.id]);
    const isBusy = busy[`conn:${conn.id}`];
    return (
      <div
        key={conn.id}
        className={`tree-row ${selectedConnId === conn.id ? "selected" : ""}`}
        onClick={() => selectConn(conn.id)}
        onDoubleClick={() => void connectTo(conn)}
        onContextMenu={(e) => openMenu(e, connMenu(conn))}
        title={`${conn.name}${conn.kind === "sqlite" ? ` · ${conn.file ?? ""}` : ` · ${conn.host ?? ""}:${conn.port ?? 3306}`}`}
      >
        <span className={`conn-dot ${isOn ? "on" : "off"}`} />
        <span className="tree-label">{conn.name}</span>
        <span className="kind-tag">{conn.kind === "mysql" ? "MY" : "SQ"}</span>
        <button
          className="tree-toggle"
          title={isOn ? "断开" : "连接"}
          onClick={(e) => {
            e.stopPropagation();
            void (isOn ? disconnectFrom(conn.id) : connectTo(conn));
          }}
        >
          {isBusy ? <div className="spinner" style={{ width: "0.8rem", height: "0.8rem" }} /> : null}
          {!isBusy &&
            (isOn ? <Unplug size={13} /> : <Plug size={13} />)}
        </button>
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
    </aside>
  );
}
