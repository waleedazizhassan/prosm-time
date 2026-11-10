// Owner 2026-11-10 ("the notification sound while the app is open is not nice - I want something of
// PROSM's own, not the usual"): PROSM's signature chime - three soft bell notes rising (A, C#, E - the
// major chord, bright and friendly), each a sine with a quiet overtone and a gentle fade, the last one
// held a little longer, with a faint shimmer an octave up. Made with the Web Audio API (no sound file
// to license); best-effort, like the other sounds: a browser that blocks audio simply stays silent.
export default function playNotificationSound(): void {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const now = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = 0.22;
    master.connect(context.destination);

    const bell = (frequency: number, start: number, length: number, level: number) => {
      for (const [ratio, share] of [[1, 1], [2, 0.18], [3.01, 0.06]] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency * ratio;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(level * share, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(start + length + 0.05);
      }
    };

    bell(880, now, 0.45, 0.8);
    bell(1108.73, now + 0.11, 0.5, 0.75);
    bell(1318.51, now + 0.22, 0.9, 0.9);
    bell(2637.02, now + 0.3, 0.6, 0.12);

    setTimeout(() => context.close().catch(() => {}), 1600);
  } catch {
    // best-effort only
  }
}
