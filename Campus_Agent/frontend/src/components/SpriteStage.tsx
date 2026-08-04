interface Props {
  src: string | null | undefined;
  name: string;
  className?: string;
  /** talk = dialogue stage; loc = location stack figure */
  size?: "talk" | "loc" | "portrait";
  /** Dialogue / pending reply — slightly stronger motion */
  speaking?: boolean;
  /** Idle breath; default on for talk/loc, off for portrait */
  alive?: boolean;
}

/** Full-body stand art — never use FaceChip (circular crop) for this. */
export function SpriteStage({
  src,
  name,
  className,
  size = "talk",
  speaking = false,
  alive,
}: Props) {
  const motionOn = alive ?? (size === "talk" || size === "loc");
  const wrapClass = [
    "sprite-stage-alive",
    `sprite-stage-alive--${size}`,
    motionOn ? "sprite-stage-alive--motion" : "",
    speaking ? "is-speaking" : "",
    className || "",
  ]
    .filter(Boolean)
    .join(" ");
  const sizeClass = `sprite-stage-img sprite-stage-img--${size}`;

  if (src) {
    return (
      <div className={wrapClass}>
        <img className={sizeClass} src={src} alt={name} draggable={false} key={src} />
      </div>
    );
  }
  return (
    <div className={wrapClass} aria-hidden>
      <div className={`${sizeClass} sprite-stage-fallback`}>
        <span>{name.slice(0, 1)}</span>
      </div>
    </div>
  );
}
