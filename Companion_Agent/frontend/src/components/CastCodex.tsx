import type { QuestState, WorldPublic } from "../types";
import HeroinePanel, { type CodexLiveOverride } from "./HeroinePanel";

type Props = {
  world: WorldPublic;
  onBack: () => void;
  focusId?: string | null;
  quest?: QuestState | null;
  onOpenQuest?: () => void;
  liveOverride?: CodexLiveOverride | null;
};

/** 人物看板：关系阶段 + 性格气质，Hub / 地点 / 对话场随时可开 */
export default function CastCodex(props: Props) {
  return <HeroinePanel {...props} />;
}
