import type { GameEventInfo } from "../types";

type Props = {
  event: GameEventInfo | null;
  onDismiss?: () => void;
};

export default function EventToast({ event, onDismiss }: Props) {
  if (!event?.label) return null;
  const isStory = Boolean(event.id?.startsWith("story_"));
  const beatHint =
    typeof event.beat_total === "number" && event.beat_total > 0
      ? ` · ${event.beat_total} 拍`
      : "";
  return (
    <div className={`gal-event-toast${isStory ? " gal-event-toast--story" : ""}`} role="status">
      <span className="gal-event-toast-kicker">{isStory ? "— 专属故事 —" : "— 事件 —"}</span>
      <strong>
        {event.label}
        {beatHint}
      </strong>
      {onDismiss && (
        <button type="button" className="gal-event-toast-close" onClick={onDismiss} aria-label="关闭">
          ×
        </button>
      )}
    </div>
  );
}
