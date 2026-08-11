import { useEffect, useState } from "react";
import { isDesktopShell, setDesktopFullscreen } from "../desktopApi";
import type { GameSettings } from "../settings";
import IntroGuideBrowser from "./IntroGuideBrowser";

type Props = {
  settings: GameSettings;
  onChange: (next: GameSettings) => void;
  onBack: () => void;
  onLogout?: () => void;
};

export default function SettingsScreen({ settings, onChange, onBack, onLogout }: Props) {
  const patch = (partial: Partial<GameSettings>) => onChange({ ...settings, ...partial });
  const [desktop, setDesktop] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    setDesktop(isDesktopShell());
  }, []);

  if (showGuide) {
    return <IntroGuideBrowser onBack={() => setShowGuide(false)} />;
  }

  const applyDisplay = async (mode: GameSettings["displayMode"]) => {
    patch({ displayMode: mode });
    if (isDesktopShell()) {
      await setDesktopFullscreen(mode === "fullscreen");
    }
  };

  return (
    <div className="gal-settings-root">
      <div className="gal-settings-shade" />
      <header className="gal-life-bar">
        <button type="button" className="gal-nav-btn" onClick={onBack}>
          ← 返回
        </button>
        <div className="gal-life-bar-main">
          <strong className="gal-life-bar-brand">系统设置</strong>
          <span className="gal-life-bar-meta">本地保存，不进云端</span>
        </div>
        <span />
      </header>

      <section className="gal-settings-panel">
        <div className="gal-settings-row gal-settings-row--stack">
          <span>
            <strong>显示模式</strong>
            <em>{desktop ? "桌面版可切换全屏 / 窗口（默认窗口）" : "浏览器请用 F11 全屏；exe 版可在此切换"}</em>
          </span>
          <div className="gal-settings-seg">
            <button
              type="button"
              className={`gal-settings-seg-btn${settings.displayMode === "windowed" ? " gal-settings-seg-btn--active" : ""}`}
              onClick={() => void applyDisplay("windowed")}
            >
              窗口化
            </button>
            <button
              type="button"
              className={`gal-settings-seg-btn${settings.displayMode === "fullscreen" ? " gal-settings-seg-btn--active" : ""}`}
              onClick={() => void applyDisplay("fullscreen")}
            >
              全屏
            </button>
          </div>
        </div>

        <label className="gal-settings-row">
          <span>
            <strong>语音朗读</strong>
            <em>对话回复是否播放 TTS</em>
          </span>
          <input
            type="checkbox"
            checked={settings.ttsEnabled}
            onChange={(e) => patch({ ttsEnabled: e.target.checked })}
          />
        </label>

        <label className="gal-settings-row">
          <span>
            <strong>语音音量</strong>
            <em>{Math.round(settings.ttsVolume * 100)}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.ttsVolume * 100)}
            disabled={!settings.ttsEnabled}
            onChange={(e) => patch({ ttsVolume: Number(e.target.value) / 100 })}
          />
        </label>

        <label className="gal-settings-row">
          <span>
            <strong>背景音乐</strong>
            <em>标题 / 地点 / 结局 BGM（无曲文件时自动静音）</em>
          </span>
          <input
            type="checkbox"
            checked={settings.bgmEnabled}
            onChange={(e) => patch({ bgmEnabled: e.target.checked })}
          />
        </label>

        <label className="gal-settings-row">
          <span>
            <strong>音乐音量</strong>
            <em>{Math.round(settings.bgmVolume * 100)}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.bgmVolume * 100)}
            disabled={!settings.bgmEnabled}
            onChange={(e) => patch({ bgmVolume: Number(e.target.value) / 100 })}
          />
        </label>

        <label className="gal-settings-row">
          <span>
            <strong>引导提示</strong>
            <em>Hub 引导文案；开则对话时始终显示输入框（关=选项为主）</em>
          </span>
          <input
            type="checkbox"
            checked={settings.softTips}
            onChange={(e) => patch({ softTips: e.target.checked })}
          />
        </label>

        <label className="gal-settings-row">
          <span>
            <strong>减少动效</strong>
            <em>关闭屏间淡入等过渡动画</em>
          </span>
          <input
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={(e) => patch({ reducedMotion: e.target.checked })}
          />
        </label>

        <div className="gal-settings-row gal-settings-row--stack">
          <span>
            <strong>对话立绘风格</strong>
            <em>舞台全身图；对话框名牌始终是 Q 版头像</em>
          </span>
          <div className="gal-settings-seg">
            <button
              type="button"
              className={`gal-settings-seg-btn${settings.spriteStyle === "anime" ? " gal-settings-seg-btn--active" : ""}`}
              onClick={() => patch({ spriteStyle: "anime" })}
            >
              二次元
            </button>
            <button
              type="button"
              className={`gal-settings-seg-btn${settings.spriteStyle === "photoreal" ? " gal-settings-seg-btn--active" : ""}`}
              onClick={() => patch({ spriteStyle: "photoreal" })}
            >
              真人化
            </button>
          </div>
        </div>

        <div className="gal-settings-row">
          <span>
            <strong>攻略</strong>
            <em>角色戏份档案与立绘设定卡（静态宣传板）</em>
          </span>
          <button type="button" className="gal-settings-seg-btn" onClick={() => setShowGuide(true)}>
            查看
          </button>
        </div>
      </section>

      <footer className="gal-settings-foot">
        {onLogout && (
          <button type="button" className="gal-action-btn gal-action-btn--ghost" onClick={onLogout}>
            切换账号
          </button>
        )}
        <button type="button" className="gal-action-btn gal-action-btn--primary" onClick={onBack}>
          完成
        </button>
      </footer>
    </div>
  );
}
