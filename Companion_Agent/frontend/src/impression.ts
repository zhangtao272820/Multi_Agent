/** Soft, non-spoiler relationship copy — numbers stay server-side only. */

export function affinityImpression(affinity: number): string {
  if (affinity < 18) return "陌生";
  if (affinity < 35) return "若即若离";
  if (affinity < 52) return "渐渐熟悉";
  if (affinity < 68) return "在意起来了";
  if (affinity < 85) return "心跳加速";
  return "难以移开视线";
}

export function trustImpression(trust: number): string {
  if (trust < 30) return "戒备";
  if (trust < 50) return "试探";
  if (trust < 70) return "愿意听你说";
  if (trust < 85) return "把心敞开一点";
  return "深深信任";
}

export function moodImpression(mood: number): string {
  if (mood <= -40) return "心情很差";
  if (mood <= -15) return "有点低落";
  if (mood < 15) return "情绪平稳";
  if (mood < 40) return "心情不错";
  return "神采飞扬";
}

/** Stage labels that spoil route progression stay vague until late. */
export function stageImpression(stageId: string, stageLabel?: string): string {
  const soft: Record<string, string> = {
    stranger: "初见",
    acquaintance: "认识中",
    friend: "朋友之间",
    crush: "说不清的心情",
    dating: "走得更近了",
    lover: "恋人",
    married: "共同生活",
  };
  if (stageId && soft[stageId]) return soft[stageId];
  const label = (stageLabel || "").trim();
  const byLabel: Record<string, string> = {
    陌生人: "初见",
    初识: "认识中",
    朋友: "朋友之间",
    暧昧: "说不清的心情",
    约会中: "走得更近了",
    恋人: "恋人",
    已婚: "共同生活",
    妻子日常: "共同生活",
  };
  if (label && byLabel[label]) return byLabel[label];
  if (label) return label;
  return "未知关系";
}

export function deltaNotice(kind: "affinity" | "trust", delta: number): string {
  if (kind === "affinity") {
    if (delta > 4) return "她看你的眼神，柔软了一点……";
    if (delta > 0) return "气氛似乎缓和了一丝。";
    if (delta < -4) return "空气忽然冷了下来。";
    if (delta < 0) return "她微微别开了脸。";
  } else {
    if (delta > 0) return "她好像更愿意相信你了。";
    if (delta < 0) return "信任出现了一道细缝。";
  }
  return "";
}

/** First-meeting atmosphere for roster bases — hide archetype spoilers. */
export const ENCOUNTER_FOG: Record<string, { title: string; hint: string; place: string }> = {
  gentle_lover: {
    title: "黄昏的路口",
    hint: "有人站在暮色里，却不肯把想说的话说完。",
    place: "校园晚樱",
  },
  tsundere: {
    title: "逆光的走廊",
    hint: "语气呛人，目光却总是多停一秒。",
    place: "教学楼",
  },
  cheerful_sun: {
    title: "喧闹的天台",
    hint: "笑声很亮，却像在掩饰别的什么。",
    place: "天台",
  },
  sarcastic_lover: {
    title: "雨夜便利店",
    hint: "毒舌底下，好像藏着一张没画完的地图。",
    place: "雨巷",
  },
  mature_sister: {
    title: "深夜的写字楼灯",
    hint: "成熟得恰到好处，却让人猜不透她的过去。",
    place: "城市夜景",
  },
  fantasy_spirit: {
    title: "雾中的林影",
    hint: "不像这个世界的人——或者只是装的。",
    place: "精灵之森",
  },
};

export function encounterFog(baseId: string): { title: string; hint: string; place: string } {
  return (
    ENCOUNTER_FOG[baseId] || {
      title: "未知的邂逅",
      hint: "再往前一步，也许就能听见她的声音。",
      place: "某处",
    }
  );
}

/** Vague first impression from profile — never MBTI / trait spoilers. */
export function firstGlanceLine(opts: {
  name: string;
  occupation?: string;
  age?: number;
  relationship?: string;
}): string {
  const bits: string[] = [];
  if (opts.occupation) bits.push(`听说是${opts.occupation}`);
  if (opts.age) bits.push(`看起来约 ${opts.age} 岁`);
  if (opts.relationship) bits.push(`你们之前……似乎有点渊源`);
  if (!bits.length) return `${opts.name}——再了解她，只能靠对话。`;
  return bits.slice(0, 2).join(" · ") + "。细节，聊着才知道。";
}
