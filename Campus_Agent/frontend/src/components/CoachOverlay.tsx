import { useMemo, useState } from "react";

const STORAGE_KEY = "campus_coach_v1";

const STEPS = [
  {
    title: "校园地图",
    body: "点击地点进入场景。图钉上的 Q 版脸是在场同学；地图上方「班级见闻」会显示别人之间发生的事。",
  },
  {
    title: "班级看板",
    body: "看板分「我的关系」与「班级见闻」：你只是班里的一名男生，其他同学也会男女/女女自由恋爱，可旁观谁成了情侣。",
  },
  {
    title: "对话与立绘",
    body: "全身立绘会随地点换场景动作、宿舍私服与情绪差分。对话时有内心气泡——对方有自己的情绪与判断。",
  },
  {
    title: "百日与结局",
    body: "推进时段可跳过上课研磨。百日结束是高考结算，感情线与班级旁观摘要会一起揭晓。",
  },
];

export function isCoachDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markCoachDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

interface Props {
  /** Only show on day 1 until dismissed. */
  dayIndex: number;
  open: boolean;
  onClose: () => void;
}

export function CoachOverlay({ dayIndex, open, onClose }: Props) {
  const [step, setStep] = useState(0);
  const visible = open && dayIndex === 1 && !isCoachDone();
  const current = useMemo(() => STEPS[step] || STEPS[0], [step]);

  if (!visible) return null;

  function finish() {
    markCoachDone();
    onClose();
  }

  return (
    <div className="coach-overlay" role="dialog" aria-modal="true" aria-label="新手引导">
      <article className="coach-card">
        <p className="coach-step">
          引导 {step + 1}/{STEPS.length}
        </p>
        <h3>{current.title}</h3>
        <p>{current.body}</p>
        <div className="coach-actions">
          <button type="button" className="btn ghost" onClick={finish}>
            跳过
          </button>
          {step + 1 < STEPS.length ? (
            <button type="button" className="btn primary" onClick={() => setStep((s) => s + 1)}>
              下一步
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={finish}>
              开始入学
            </button>
          )}
        </div>
      </article>
    </div>
  );
}
