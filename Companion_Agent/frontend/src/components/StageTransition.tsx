import { useEffect, useState } from "react";

type Props = {
  /** 非空时播放一次黑场过场 */
  signal: number;
  caption?: string;
  durationMs?: number;
  onDone?: () => void;
};

/**
 * 轻量黑场过场：出行 / 进谈 / 告辞回 Hub 用。
 * signal 递增触发；不改 WS 协议。
 */
export default function StageTransition({
  signal,
  caption = "",
  durationMs = 520,
  onDone,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!signal) return;
    setText(caption);
    setVisible(true);
    const t = window.setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, durationMs);
    return () => window.clearTimeout(t);
  }, [signal, caption, durationMs, onDone]);

  if (!visible) return null;
  return (
    <div className="gal-stage-transition" aria-hidden={!visible}>
      <div className="gal-stage-transition-veil" />
      {text ? <p className="gal-stage-transition-caption">{text}</p> : null}
    </div>
  );
}
