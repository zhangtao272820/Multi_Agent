import type { CampusSettings } from "../settings";

type Props = {
  settings: CampusSettings;
  onChange: (next: CampusSettings) => void;
  onBack: () => void;
};

export function SettingsScreen({ settings, onChange, onBack }: Props) {
  const patch = (partial: Partial<CampusSettings>) => onChange({ ...settings, ...partial });

  return (
    <section className="screen settings-screen">
      <header className="settings-head">
        <button type="button" className="btn ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="settings-head-copy">
          <h2>系统设置</h2>
          <p>本地保存，不进云端</p>
        </div>
        <span />
      </header>

      <div className="settings-panel">
        <label className="settings-row">
          <span>
            <strong>背景音乐</strong>
            <em>标题 / 地点 / 对话 / 结局 BGM（无曲文件时自动静音）</em>
          </span>
          <input
            type="checkbox"
            checked={settings.bgmEnabled}
            onChange={(e) => patch({ bgmEnabled: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>
            <strong>音乐音量</strong>
            <em>{Math.round(settings.bgmVolume * 100)}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(settings.bgmVolume * 100)}
            disabled={!settings.bgmEnabled}
            onChange={(e) => patch({ bgmVolume: Number(e.target.value) / 100 })}
          />
        </label>

        <label className="settings-row">
          <span>
            <strong>减少动效</strong>
            <em>关闭标题背景漂移等过渡动画</em>
          </span>
          <input
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={(e) => patch({ reducedMotion: e.target.checked })}
          />
        </label>
      </div>

      <footer className="settings-foot">
        <button type="button" className="btn primary" onClick={onBack}>
          完成
        </button>
      </footer>
    </section>
  );
}
