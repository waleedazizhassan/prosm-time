// PROSM Time - the mid-shift geofence-exit alert's audio cue (§ live
// UX review, user-directed: "sound + reason + scheduled reminder").
// A short synthesized two-tone beep via the Web Audio API rather than
// a bundled audio file - there is no licensed sound asset in this
// repo, and inventing/sourcing one for a single alert isn't
// warranted. Best-effort only, matching this codebase's own posture
// on every other client-only capability (geolocation, presence
// sampling): a browser that blocks autoplay/Web Audio (no prior user
// gesture, or a locked-down policy) never surfaces as an error - the
// reason-entry UI (ExceptionsCard) still works without the sound.
export default function playAlertSound(): void {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const now = context.currentTime;

    [880, 660].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;

      const start = now + index * 0.22;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
      gain.gain.linearRampToValueAtTime(0, start + 0.2);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    });

    setTimeout(() => context.close().catch(() => {}), 600);
  } catch {
    // Best-effort only - see this file's own header comment.
  }
}
