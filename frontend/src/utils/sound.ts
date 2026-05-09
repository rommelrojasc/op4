/**
 * Play a short notification chime using the Web Audio API.
 * No external audio files required.
 */
let _ctx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!_ctx) _ctx = new AudioContext();
  return _ctx;
}

export function playDoneSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Two-tone ascending chime
    const freqs = [660, 880];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.3);
    });
  } catch {
    // Silently ignore if audio is unavailable
  }
}
