export type ChoiceKind = "soft" | "branch" | "stage_consent" | "confession_consent";

type Props = {
  choices: string[];
  kind?: ChoiceKind;
  disabled?: boolean;
  onChoice: (text: string, index: number, kind: ChoiceKind) => void;
  /** 覆盖默认提示文案 */
  hint?: string;
};

function isDecisiveChoice(kind: ChoiceKind): boolean {
  return kind === "branch" || kind === "stage_consent" || kind === "confession_consent";
}

/** soft：可选回复；branch/consent：会影响关系，须传 choice_index。 */
export default function ChoiceOverlay({ choices, kind = "soft", disabled, onChoice, hint }: Props) {
  if (!choices.length) return null;
  const decisive = isDecisiveChoice(kind);
  const hintText =
    hint ||
    (kind === "stage_consent"
      ? "是否确认推进这段关系"
      : kind === "confession_consent"
        ? "她在等你的回应"
        : decisive
          ? "这一选择会影响她的态度"
          : "选择你想说的");
  return (
    <div
      className={`gal-choice-overlay gal-choice-overlay--primary gal-choice-overlay--virtues${
        decisive ? " gal-choice-overlay--branch" : ""
      }`}
      role="group"
      aria-label={decisive ? "重要选择" : "选择你想说的"}
    >
      <p className="gal-choice-hint">{hintText}</p>
      <div className="gal-choice-list">
        {choices.map((label, index) => (
          <button
            key={`${label}-${index}`}
            type="button"
            className={`gal-choice-btn${decisive ? " gal-choice-btn--branch" : ""}`}
            disabled={disabled}
            onClick={() => onChoice(label, index, kind)}
            style={{ animationDelay: `${index * 55}ms` }}
          >
            <span className="gal-choice-index">{String.fromCharCode(65 + index)}</span>
            <span className="gal-choice-label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
