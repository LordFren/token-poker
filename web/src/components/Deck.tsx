import { cardLabel, isNumericCard, isNumericSpCard } from "@token-poker/shared";

/** Renders either the token deck or the story-point deck; one click casts that dimension. */
export function Deck<V extends string>({
  values,
  kind,
  selected,
  disabled,
  onPick,
}: {
  values: readonly V[];
  kind: "tokens" | "points";
  selected: V | null;
  disabled?: boolean;
  onPick: (v: V) => void;
}) {
  const numeric = kind === "tokens" ? isNumericCard : isNumericSpCard;
  const title = (v: V): string => {
    if (v === "?") return "unsure";
    if (v === "coffee") return "need a break";
    return kind === "tokens" ? `${Number(v).toLocaleString()} tokens` : `${v} story points`;
  };
  return (
    <div className="deck">
      {values.map((v) => (
        <button
          key={v}
          className={`tcard${selected === v ? " selected" : ""}`}
          disabled={disabled}
          onClick={() => onPick(v)}
          aria-pressed={selected === v}
          title={title(v)}
        >
          {cardLabel(v)}
          {numeric(v) && <span className="sub">{kind === "tokens" ? "tokens" : "pts"}</span>}
        </button>
      ))}
    </div>
  );
}
