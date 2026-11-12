export type ShiftMood = "great" | "normal" | "tough";

const COLORS: Record<ShiftMood, string> = { great: "#16a34a", normal: "#d97706", tough: "#dc2626" };

// Owner 2026-11-11: "how was today's work?" - three simple drawn faces (a smile, a straight mouth, a
// frown). Outlined until chosen; the chosen one is filled with its colour.
export default function MoodFace({ mood, size = 56, active = false }: { mood: ShiftMood; size?: number; active?: boolean }) {
  const color = COLORS[mood];
  const stroke = active ? "#fff" : "currentColor";
  const mouth =
    mood === "great" ? "M17 33 Q28 45 39 33" : mood === "normal" ? "M18 36 L38 36" : "M18 40 Q28 30 38 40";
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r="25" fill={active ? color : "none"} stroke={active ? color : "currentColor"} strokeWidth="2.5" />
      {mood === "great" ? (
        <>
          <path d="M16 23 Q20 18 24 23" fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
          <path d="M32 23 Q36 18 40 23" fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="20" cy="22" r="2.4" fill={stroke} />
          <circle cx="36" cy="22" r="2.4" fill={stroke} />
        </>
      )}
      <path d={mouth} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
