import { useEffect, useMemo } from "react";
import type { EndingInfo, VnPage } from "../types";
import VnPageRunner from "./VnPageRunner";

type Props = {
  ending: EndingInfo;
  characterName: string;
  characterId?: string;
  onRestart: () => void;
  onMenu: () => void;
  onPlayBgm?: (trackId: string) => void;
};

function resolveSprite(ending: EndingInfo, characterId?: string) {
  const present = ending.presentation;
  const sp = present?.sprite;
  const cid = sp?.character_id || characterId || ending.character_ids?.[0] || "";
  const emotion = sp?.emotion || (ending.type === "bad" ? "sad" : ending.type === "secret" ? "love" : "love");
  const outfit = sp?.outfit || "";
  return { cid, emotion, outfit };
}

function narrationPages(ending: EndingInfo, characterId: string, emotion: string, outfit: string): VnPage[] {
  const raw = (ending.presentation?.pages || []).map((p) => String(p || "").trim()).filter(Boolean);
  const bits = raw.length
    ? raw
    : [ending.description, ending.cg_hint].map((x) => String(x || "").trim()).filter(Boolean);
  const texts = bits.length ? bits : [ending.description || "……"];
  return texts.map((text) => ({
    text,
    voice: "narration" as const,
    sprite: characterId
      ? { character_id: characterId, outfit: outfit || undefined, emotion: emotion || undefined }
      : undefined,
    bg: ending.presentation?.bg,
  }));
}

export default function EndingScreen({
  ending,
  characterName,
  characterId,
  onRestart,
  onMenu,
  onPlayBgm,
}: Props) {
  const type = ending.type || "good";
  const typeClass =
    type === "bad"
      ? "ending-screen--bad"
      : type === "normal"
        ? "ending-screen--normal"
        : type === "secret"
          ? "ending-screen--secret"
          : "ending-screen--good";
  const typeLabel =
    type === "secret"
      ? "真结局"
      : type === "good"
        ? "好结局"
        : type === "normal"
          ? "软结局"
          : type === "bad"
            ? "坏结局"
            : "结局";

  const bg = ending.presentation?.bg || (type === "bad" ? "rain" : type === "secret" ? "starry" : "cafe");
  const { cid, emotion, outfit } = resolveSprite(ending, characterId);
  const pages = useMemo(
    () => narrationPages(ending, cid, emotion, outfit),
    [ending, cid, emotion, outfit],
  );

  useEffect(() => {
    const track = ending.presentation?.bgm;
    if (track && onPlayBgm) onPlayBgm(track);
  }, [ending.presentation?.bgm, onPlayBgm]);

  return (
    <div className={`ending-screen ending-screen--cinema ${typeClass}`}>
      <div className="ending-screen-meta">
        <p className="ending-type-badge">{typeLabel}</p>
        <p className="ending-eyebrow">{characterName}</p>
        <h2>{ending.title}</h2>
        {ending.subtitle ? <p className="ending-subtitle">{ending.subtitle}</p> : null}
      </div>
      <VnPageRunner
        pages={pages}
        characterId={cid}
        characterName={characterName}
        defaultBg={String(bg || "").replace(/\.png$/i, "")}
        ariaLabel="结局旁白"
        skipLabel="跳过"
        holdOnLast
        onDone={onMenu}
        footer={
          <>
            <button type="button" className="btn-primary" onClick={onRestart}>
              再开一局
            </button>
            <button type="button" className="btn-ghost" onClick={onMenu}>
              回主菜单
            </button>
          </>
        }
      />
    </div>
  );
}
