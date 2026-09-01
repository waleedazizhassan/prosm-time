// Ported from PROSM Platform's own src/core/utils/greeting.js (§ visual
// consistency pass, Header greeting). Pure, framework-free time-of-day
// detection. Uses Date.prototype.getHours(), which returns the hour in
// the browser's local timezone - already exactly "the user's local
// time", no separate timezone-detection step required.
export type GreetingPeriod = "morning" | "afternoon" | "evening" | "night";

// Boundaries (local hour, 24h clock):
//   morning   05:00-11:59
//   afternoon 12:00-16:59
//   evening   17:00-20:59
//   night     21:00-04:59 (wraps past midnight)
export function getGreetingPeriod(date: Date = new Date()): GreetingPeriod {
  const hour = date.getHours();

  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}
