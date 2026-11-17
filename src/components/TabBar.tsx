import { Home, Plug, Table2, TerminalSquare, X } from "lucide-react";
import { useStore, type Tab } from "../store";

function TabIcon({ tab }: { tab: Tab }) {
  const size = 13;
  switch (tab.kind) {
    case "connection":
      return <Plug size={size} />;
    case "table":
      return <Table2 size={size} />;
    case "query":
      return <TerminalSquare size={size} />;
    default:
      return <Home size={size} />;
  }
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const activate = useStore((s) => s.activateTab);
  const close = useStore((s) => s.closeTab);

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTab ? "active" : ""}`}
          onClick={() => activate(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1 && t.kind !== "welcome") close(t.id);
          }}
          title={t.title}
        >
          <TabIcon tab={t} />
          <span className="tab-title">{t.title}</span>
          {t.kind !== "welcome" && (
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
              title="关闭"
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
