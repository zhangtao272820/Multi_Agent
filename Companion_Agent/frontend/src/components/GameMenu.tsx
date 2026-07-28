type Props = {
  open: boolean;
  hasWorld: boolean;
  onContinue: () => void;
  onManualSave?: () => void;
  onLoadSave: () => void;
  onCodex?: () => void;
  onSprites: () => void;
  onSettings: () => void;
  onTitle: () => void;
};

export default function GameMenu({
  open,
  hasWorld,
  onContinue,
  onManualSave,
  onLoadSave,
  onCodex,
  onSprites,
  onSettings,
  onTitle,
}: Props) {
  if (!open) return null;
  return (
    <div className="gal-game-menu" role="dialog" aria-modal="true" aria-label="游戏菜单">
      <button type="button" className="gal-game-menu-backdrop" aria-label="关闭" onClick={onContinue} />
      <div className="gal-game-menu-panel">
        <h2>菜单</h2>
        <nav>
          <button type="button" className="gal-action-btn gal-action-btn--primary" onClick={onContinue}>
            继续游戏
          </button>
          {onCodex && (
            <button type="button" className="gal-action-btn" disabled={!hasWorld} onClick={onCodex}>
              人物看板
            </button>
          )}
          {onManualSave && (
            <button type="button" className="gal-action-btn" disabled={!hasWorld} onClick={onManualSave}>
              手动存档
            </button>
          )}
          <button type="button" className="gal-action-btn" onClick={onLoadSave}>
            读档
          </button>
          <button type="button" className="gal-action-btn" onClick={onSprites}>
            立绘大全
          </button>
          <button type="button" className="gal-action-btn" onClick={onSettings}>
            系统设置
          </button>
          <button
            type="button"
            className="gal-action-btn gal-action-btn--ghost"
            onClick={onTitle}
            disabled={!hasWorld && false}
          >
            返回标题
          </button>
        </nav>
      </div>
    </div>
  );
}
