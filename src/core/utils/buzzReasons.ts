// The Buzz reasons the server accepts (send_prosm_time_buzz). Owner 2026-11-10; more ready messages 2026-11-16
// (migration 20261116100000).
export const BUZZ_REASONS = ["clock_in", "clock_out", "call_me", "attention", "go_home_early", "tomorrow_off", "dont_be_late", "end_break", "come_to_office", "check_messages", "shift_changed", "well_done"] as const;
export type BuzzReason = (typeof BUZZ_REASONS)[number];
