// Owner 2026-11-10: a Buzz - the phone vibrates and a buzzer sounds (bzz - bzz - bzzzz), unlike the
// chime of an ordinary notification and the siren of an SOS. Synthesized with the Web Audio API: a low
// square-wave hum with a fast flutter, three pulses. Best-effort: a browser that blocks audio is silent.
export default function playBuzzSound(): void {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const now = context.currentTime + 0.02;
    const master = context.createGain();
    master.gain.value = 0.32;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1800;
    tone.connect(master);
    master.connect(context.destination);

    const pulse = (start: number, length: number) => {
      const hum = context.createOscillator();
      hum.type = "square";
      hum.frequency.value = 165;
      const flutter = context.createOscillator();
      flutter.frequency.value = 28;
      const flutterDepth = context.createGain();
      flutterDepth.gain.value = 0.35;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.65, start + 0.015);
      gain.gain.setValueAtTime(0.65, start + length - 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      flutter.connect(flutterDepth);
      flutterDepth.connect(gain.gain);
      hum.connect(gain);
      gain.connect(tone);
      hum.start(start);
      flutter.start(start);
      hum.stop(start + length + 0.02);
      flutter.stop(start + length + 0.02);
    };
    pulse(now, 0.22);
    pulse(now + 0.32, 0.22);
    pulse(now + 0.64, 0.55);
    setTimeout(() => context.close().catch(() => {}), 1600);
  } catch {
    // best-effort only
  }
}

/** The same rhythm as the sound, on phones that vibrate from the page. */
export function vibrateBuzz(): void {
  try {
    navigator.vibrate?.([220, 100, 220, 100, 550]);
  } catch {
    // not supported
  }
}
