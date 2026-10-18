// Audit 4.4 (2026-10-13) - who may act on whose behalf: only people below
// the caller's own role; the Owner may act for anyone. The server enforces
// the same rule (prosm_time_can_act_on_behalf_of, 20261013150000).
export function roleRank(member: { isOwner: boolean; roleKey: string }): number {
  if (member.isOwner) return 4;
  if (member.roleKey === "manager") return 3;
  if (member.roleKey === "supervisor") return 2;
  return 1;
}

// The Owner is never clocked in or out (owner 2026-10-18).
export function canActOnBehalfOf(caller: { isOwner: boolean; roleKey: string }, subject: { isOwner: boolean; roleKey: string }): boolean {
  return !subject.isOwner && (caller.isOwner || roleRank(subject) < roleRank(caller));
}
