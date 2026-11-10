// Owner 2026-11-10: a Buzz - the phone vibrates and a sound plays, unlike the chime of an ordinary
// notification and the siren of an SOS. The owner chose "knock knock + ping" (option 2 of three): two
// soft knocks, like on a door, then a bright ping that rises. Synthesized with the Web Audio API (no
// sound file to license). Best-effort: a browser that blocks audio simply stays silent.
export default function playBuzzSound(): void {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const now = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);

    // a knock: two low sines (180 and 410 Hz) that start at once and die away fast
    const knock = (start: number) => {
      for (const [frequency, level] of [[180, 1], [410, 0.6]] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(level, start + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start);
        oscillator.stop(start + 0.22);
      }
    };

    // the ping: rises from 1320 to 1760 Hz in 80 ms and rings out
    const ping = (start: number) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(1320, start);
      oscillator.frequency.linearRampToValueAtTime(1760, start + 0.08);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.55, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.95);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 1);
    };

    knock(now);
    knock(now + 0.22);
    ping(now + 0.5);
    setTimeout(() => context.close().catch(() => {}), 1800);
  } catch {
    // best-effort only
  }
}

/** The same rhythm as the sound (knock, knock, ping), on phones that vibrate from the page. */
export function vibrateBuzz(): void {
  try {
    navigator.vibrate?.([120, 100, 120, 180, 400]);
  } catch {
    // not supported
  }
}
