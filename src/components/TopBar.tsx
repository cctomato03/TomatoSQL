import { Cloud, Info, Moon, Settings, Sun, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { THEMES, getTheme } from "../themes";

export function TopBar({
  onOpenSettings,
  onOpenCloud,
  onOpenSync,
  onOpenAbout,
}: {
  onOpenSettings: () => void;
  onOpenCloud: () => void;
  onOpenSync: () => void;
  onOpenAbout: () => void;
}) {
  const info = useStore((s) => s.info);
  const settings = useStore((s) => s.ws.settings);
  const setSettings = useStore((s) => s.setSettings);
  const theme = getTheme(settings.themeId);
  const alt = theme.dark
    ? THEMES.find((t) => !t.dark)!
    : THEMES.find((t) => t.dark)!;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-logo">T</div>
        <div className="brand-name">TomatoSQL</div>
        <div className="brand-badge">v{info?.version ?? "1.0.0"}</div>
      </div>

      <div className="topbar-actions">
        <button
          className="icon-btn"
          title={`切换到 ${alt.name}`}
          onClick={() => setSettings({ themeId: alt.id })}
        >
          {theme.dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="icon-btn" title="结构同步 / 数据迁移" onClick={onOpenSync}>
          <RefreshCw size={16} />
        </button>
        <button className="icon-btn" title="云同步" onClick={onOpenCloud}>
          <Cloud size={16} />
        </button>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}>
          <Settings size={16} />
        </button>
        <button className="icon-btn" title="关于" onClick={onOpenAbout}>
          <Info size={16} />
        </button>
      </div>
    </header>
  );
}
