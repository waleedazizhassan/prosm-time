export interface SirenHandle {
  stop: () => void;
}

// PROSM Time - user-directed: SOS/emergency notifications need more
// than the standard alert beep - "a continuous siren sound for 10
// seconds." Synthesized via the Web Audio API (same posture as
// playAlertSound.ts - no licensed audio asset in this repo): a single
// oscillator sweeping between two frequencies on a ~1s cycle, the
// classic two-tone wail. Returns a stop() handle so the overlay that
// triggers this can cut the siren short the moment an admin/owner
// dismisses or acts on the alert, rather than always running the full
// duration. Best-effort only, matching every other client-only
// capability in this codebase - a browser that blocks autoplay/Web
// Audio never surfaces as an error, it's just silent.
export default function playSirenSound(durationSeconds = 10): SirenHandle {
  const noop: SirenHandle = { stop: () => {} };
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return noop;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    gain.gain.value = 0.18;

    const now = context.currentTime;
    const end = now + durationSeconds;
    const cycleSeconds = 1;

    oscillator.frequency.setValueAtTime(520, now);
    for (let t = now; t < end; t += cycleSeconds) {
      oscillator.frequency.linearRampToValueAtTime(1080, t + cycleSeconds / 2);
      oscillator.frequency.linearRampToValueAtTime(520, t + cycleSeconds);
    }

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(end);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.05);
        oscillator.stop(context.currentTime + 0.06);
      } catch {
        // Already stopped/closed - nothing to do.
      }
      setTimeout(() => context.close().catch(() => {}), 200);
    };

    setTimeout(() => {
      stopped = true;
      context.close().catch(() => {});
    }, durationSeconds * 1000 + 300);

    return { stop };
  } catch {
    return noop;
  }
}
