import type { ReactNode } from "react";
import { brandAvatarUrl, brandLogoUrl } from "@brand/react/assetMap.js";

export type StudioPanel = "tools" | "compose" | "upload" | "progress";

type RailItem = {
  id: StudioPanel;
  label: string;
  icon: string;
};

const RAIL: RailItem[] = [
  { id: "tools", label: "能力", icon: "◈" },
  { id: "compose", label: "创作", icon: "✎" },
  { id: "upload", label: "上传", icon: "↑" },
  { id: "progress", label: "进度", icon: "◎" },
];

const PANEL_TITLE: Record<StudioPanel, string> = {
  tools: "能力台",
  compose: "文本创作",
  upload: "上传与分析",
  progress: "创作进度",
};

type Props = {
  activePanel: StudioPanel;
  drawerOpen: boolean;
  onPanelChange: (panel: StudioPanel) => void;
  onDrawerToggle: () => void;
  topExtra?: ReactNode;
  stageOverlay?: ReactNode;
  player: ReactNode;
  children: ReactNode;
  stageHint?: string;
  busy?: boolean;
};

export function StudioShell({
  activePanel,
  drawerOpen,
  onPanelChange,
  onDrawerToggle,
  topExtra,
  stageOverlay,
  player,
  children,
  stageHint,
  busy,
}: Props) {
  return (
    <div
      className={`studio-shell brand-shell ch-lite${drawerOpen ? " studio-shell--drawer-open" : ""}${busy ? " studio-shell--busy" : ""}`}
      data-agent="music"
    >
      <header className="studio-topbar">
        <div className="studio-brand">
          <img className="studio-brand-logo" src={brandLogoUrl("music")} alt="" width={32} height={32} />
          <div>
            <span className="studio-brand-name">贪狼 · Music</span>
            <span className="studio-brand-sub">可视化工作室</span>
          </div>
          <img className="studio-brand-avatar" src={brandAvatarUrl("music")} alt="" width={40} height={40} title="贪狼虚拟形象" />
        </div>
        {topExtra}
        <button
          type="button"
          className="studio-drawer-toggle"
          aria-expanded={drawerOpen}
          onClick={onDrawerToggle}
        >
          {drawerOpen ? "收起面板" : "展开面板"}
        </button>
      </header>

      <nav className="studio-rail" aria-label="功能导航">
        {RAIL.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`studio-rail-btn${activePanel === item.id ? " studio-rail-btn--active" : ""}`}
            aria-current={activePanel === item.id ? "page" : undefined}
            title={item.label}
            onClick={() => {
              onPanelChange(item.id);
              if (!drawerOpen) onDrawerToggle();
            }}
          >
            <span className="studio-rail-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="studio-rail-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <aside
        className={`studio-drawer${drawerOpen ? "" : " studio-drawer--closed"}`}
        aria-label={PANEL_TITLE[activePanel]}
        aria-hidden={!drawerOpen}
      >
        <div className="studio-drawer-head">
          <h2 className="studio-drawer-title">{PANEL_TITLE[activePanel]}</h2>
        </div>
        <div className="studio-drawer-body app-chat-scroll">{children}</div>
      </aside>

      <main className="studio-stage" aria-label="音乐可视化舞台">
        {stageHint && !stageOverlay ? (
          <p className="studio-stage-hint">{stageHint}</p>
        ) : null}
        {stageOverlay}
      </main>

      <footer className="studio-player">{player}</footer>
    </div>
  );
}
