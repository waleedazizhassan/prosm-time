export interface SirenHandle {
  stop: () => void;
}

// PROSM Time - SOS/emergency notifications sound a siren for 30 seconds (user-directed).
// Owner 2026-11-10 ("make it like PROSM Site Safety's siren - louder, like the police"): a police-
// style siren - the slow "wail" (rising and falling between about 600 and 1400 Hz), then the fast
// "yelp", in turns - from two slightly detuned sawtooth voices shaped into a horn-like tone, much
// louder than before, through a compressor so it stays loud without cracking. Synthesized with the
// Web Audio API (no sound file to license). Returns stop() so the overlay can cut it short the
// moment the alert is dismissed or opened. Best-effort: a browser that blocks audio stays silent.
export default function playSirenSound(durationSeconds = 30): SirenHandle {
  const noop: SirenHandle = { stop: () => {} };
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return noop;

    const context = new AudioContextClass();
    const now = context.currentTime;
    const end = now + durationSeconds;

    // the horn: two sawtooth voices a few cents apart, a gentle low-pass, a compressor, loud
    const voices = [0, 7].map((cents) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sawtooth";
      oscillator.detune.value = cents;
      return oscillator;
    });
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3200;
    tone.Q.value = 0.8;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 6;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.55, now + 0.08);
    for (const voice of voices) voice.connect(tone);
    tone.connect(compressor);
    compressor.connect(gain);
    gain.connect(context.destination);

    // the pattern: 2 wails (3.2 s each), then 3 s of yelp (0.3 s each), and again
    const low = 620;
    const high = 1420;
    let t = now;
    for (const voice of voices) voice.frequency.setValueAtTime(low, now);
    while (t < end) {
      for (let i = 0; i < 2 && t < end; i += 1) {
        for (const voice of voices) {
          voice.frequency.exponentialRampToValueAtTime(high, t + 1.6);
          voice.frequency.exponentialRampToValueAtTime(low, t + 3.2);
        }
        t += 3.2;
      }
      for (let i = 0; i < 10 && t < end; i += 1) {
        for (const voice of voices) {
          voice.frequency.exponentialRampToValueAtTime(high, t + 0.15);
          voice.frequency.exponentialRampToValueAtTime(low, t + 0.3);
        }
        t += 0.3;
      }
    }

    for (const voice of voices) {
      voice.start(now);
      voice.stop(end);
    }

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.05);
        for (const voice of voices) voice.stop(context.currentTime + 0.06);
      } catch {
        // already stopped or closed
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
