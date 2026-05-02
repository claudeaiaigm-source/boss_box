import React, { useState, useEffect, useRef, useCallback } from 'react';

// Build a 0.5s silent WAV (8 kHz, 8-bit mono, ~4 KB). iOS needs real media data
// to switch the audio session to "media" routing — a 0-byte data chunk is unreliable.
function buildSilentWavUrl() {
  const sampleRate = 8000;
  const numSamples = sampleRate / 2; // 0.5s
  const buf = new ArrayBuffer(44 + numSamples);
  const v = new DataView(buf);
  v.setUint32(0, 0x52494646, false);  // "RIFF"
  v.setUint32(4, 36 + numSamples, true);
  v.setUint32(8, 0x57415645, false);  // "WAVE"
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate, true);  // byte rate
  v.setUint16(32, 1, true);           // block align
  v.setUint16(34, 8, true);           // 8-bit
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, numSamples, true);
  new Uint8Array(buf, 44).fill(128);  // 8-bit unsigned silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// ============= AUDIO ENGINE (Web Audio API nativo) =============
// Original arcade chiptune. Native Web Audio = funciona en todos los navegadores sin dependencias.
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicRunning = false;
    this.musicTimer = null;
    this.musicStep = 0;
  }

  // NOTE: must remain callable synchronously from a user-gesture handler.
  // iOS Safari drops the user-activation flag across `await`, which silently
  // rejects silentAudio.play() and breaks the silent-switch bypass. So we
  // kick off ctx.resume() AND silentAudio.play() in the same sync tick, then
  // await both at the end.
  init() {
    try {
      if (this.ctx) {
        const resumeP = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
        const silentP = (this.silentAudio && this.silentAudio.paused)
          ? this.silentAudio.play().catch(() => {})
          : Promise.resolve();
        return Promise.all([resumeP, silentP]).then(() => true).catch(() => true);
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return Promise.resolve(false);
      this.ctx = new Ctx();

      // === iOS SILENT SWITCH BYPASS ===
      // Looping a real (silent) <audio> tag flips iOS into "media playback" so
      // Web Audio is audible even with the hardware silent switch ON.
      this.silentAudio = new Audio(buildSilentWavUrl());
      this.silentAudio.loop = true;
      this.silentAudio.volume = 0.001;
      this.silentAudio.setAttribute('playsinline', '');
      this.silentAudio.setAttribute('webkit-playsinline', '');

      // Fire both promises synchronously (still inside the user gesture).
      const resumeP = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
      const silentP = this.silentAudio.play().catch(() => {});

      // Web Audio gain nodes
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.muted ? 0 : 0.14;
      this.musicGain.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.muted ? 0 : 0.7;
      this.sfxGain.connect(this.ctx.destination);

      // iOS Web Audio unlock: play 1-sample silent buffer
      const buffer = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.ctx.destination);
      src.start(0);

      return Promise.all([resumeP, silentP]).then(() => true).catch(() => true);
    } catch (e) {
      console.warn('Audio init error:', e);
      return Promise.resolve(false);
    }
  }

  // ==== Primitives ====
  tone({ freq, duration = 0.1, type = 'square', attack = 0.005, release = 0.04, volume = 0.5, dest }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(volume, now + attack);
    env.gain.setValueAtTime(volume, now + Math.max(attack, duration - release));
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(env);
    env.connect(dest || this.sfxGain);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  sweep({ freqStart, freqEnd, duration = 0.3, type = 'square', volume = 0.5, dest }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, freqEnd), now + duration);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(volume, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(env);
    env.connect(dest || this.sfxGain);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  noise({ duration = 0.05, volume = 0.5, filterFreq, filterQ = 1, type = 'bandpass', dest }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const sampleCount = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(volume, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    let last = src;
    if (filterFreq) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = filterFreq;
      filter.Q.value = filterQ;
      src.connect(filter);
      last = filter;
    }
    last.connect(env);
    env.connect(dest || this.sfxGain);
    src.start(now);
  }

  // ==== SFX ====

  // Whoosh al lanzar un golpe
  punch() {
    this.noise({ duration: 0.07, volume: 0.4, filterFreq: 1800, filterQ: 1.5 });
  }

  // Impacto recibido — más profundo y con cuerpo
  hit(power = false) {
    if (!this.ctx) return;
    // Thud: noise burst grave
    this.noise({ duration: power ? 0.08 : 0.05, volume: power ? 0.55 : 0.4, filterFreq: power ? 150 : 220, filterQ: 0.7 });
    // Body: low sweep
    this.sweep({
      freqStart: power ? 200 : 280,
      freqEnd: power ? 28 : 55,
      duration: power ? 0.32 : 0.18,
      type: 'sine',
      volume: power ? 0.7 : 0.55,
    });
    // Power punches: extra "punch" overlay
    if (power) {
      this.tone({ freq: 90, duration: 0.18, type: 'square', volume: 0.4 });
    }
  }

  // Bloqueo: clinc metálico
  block() {
    this.tone({ freq: 1400, duration: 0.08, type: 'sine', volume: 0.35 });
    this.tone({ freq: 2100, duration: 0.06, type: 'sine', volume: 0.25 });
    this.tone({ freq: 800,  duration: 0.05, type: 'square', volume: 0.15 });
  }

  // Esquive: whoosh de aire
  dodge() {
    this.sweep({ freqStart: 900, freqEnd: 200, duration: 0.22, type: 'sawtooth', volume: 0.18 });
    this.noise({ duration: 0.2, volume: 0.18, filterFreq: 700, filterQ: 1.2 });
  }

  // Campana del ring — armónicos múltiples
  bell(volume = 0.4) {
    if (!this.ctx) return;
    const freqs = [800, 1200, 1600, 2400, 3000];
    const decays = [1.6, 1.4, 1.1, 0.8, 0.6];
    freqs.forEach((f, i) => {
      this.tone({
        freq: f, duration: decays[i], type: 'sine',
        volume: volume / (i + 1), attack: 0.001, release: decays[i] * 0.9,
      });
    });
  }

  // K.O. — sirena descendente + triple campana "ding-ding-ding"
  ko() {
    if (!this.ctx) return;
    // sirena dramática
    this.sweep({ freqStart: 500, freqEnd: 50, duration: 1.2, type: 'square', volume: 0.45 });
    this.sweep({ freqStart: 250, freqEnd: 25, duration: 1.2, type: 'sawtooth', volume: 0.25 });
    // triple campana K.O. clásica
    setTimeout(() => this.bell(0.5), 1200);
    setTimeout(() => this.bell(0.5), 1700);
    setTimeout(() => this.bell(0.55), 2200);
  }

  // Fanfarria de victoria
  victory() {
    if (!this.ctx) return;
    const notes = [
      [523.25, 0],   [659.25, 130], [783.99, 260], [1046.5, 390],
      [1046.5, 600], [1318.5, 780],
    ];
    notes.forEach(([f, t]) => setTimeout(() =>
      this.tone({ freq: f, duration: 0.18, type: 'square', volume: 0.5 }), t));
    setTimeout(() => this.bell(0.4), 900);
  }

  // Derrota — descendente
  defeat() {
    if (!this.ctx) return;
    [523.25, 466.16, 392, 349.23, 311.13].forEach((f, i) =>
      setTimeout(() => this.tone({ freq: f, duration: 0.32, type: 'square', volume: 0.45 }), i * 220));
  }

  // ==== Música chiptune (loop de 16 pasos / 8th notes) ====
  startMusic() {
    if (!this.ctx || this.muted || this.musicRunning) return;
    this.musicRunning = true;
    this.musicStep = 0;
    const bpm = 148;
    const stepMs = (60000 / bpm) / 2; // 8th notes
    this.musicTimer = setInterval(() => {
      if (!this.musicRunning) return;
      this.playMusicStep(this.musicStep);
      this.musicStep = (this.musicStep + 1) % 16;
    }, stepMs);
  }

  stopMusic() {
    this.musicRunning = false;
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }

  playMusicStep(step) {
    if (!this.ctx || !this.musicGain) return;
    const dest = this.musicGain;
    // Bass: A minor riff
    const bass = [110, 110, 82.4, 110,  110, 110, 82.4, 98,
                  110, 110, 82.4, 110,  73.4, 73.4, 82.4, 82.4];
    this.tone({ freq: bass[step], duration: 0.18, type: 'square', volume: 0.55, release: 0.05, dest });
    // Lead melody
    const lead = [440, 523.25, 659.25, 523.25,  587.33, 698.46, 659.25, 587.33,
                  440, 523.25, 659.25, 783.99,  880, 783.99, 659.25, 587.33];
    this.tone({ freq: lead[step], duration: 0.16, type: 'square', volume: 0.28, release: 0.04, dest });
    // Drums
    const beatInBar = step % 8;
    if (beatInBar === 0 || beatInBar === 4) {
      // Kick
      this.sweep({ freqStart: 110, freqEnd: 30, duration: 0.1, type: 'sine', volume: 0.7, dest });
    }
    if (beatInBar === 2 || beatInBar === 6) {
      // Snare
      this.noise({ duration: 0.06, volume: 0.4, filterFreq: 1800, filterQ: 1, dest });
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.musicGain) this.musicGain.gain.value = muted ? 0 : 0.14;
    if (this.sfxGain) this.sfxGain.gain.value = muted ? 0 : 0.7;
    if (muted) {
      this.stopMusic();
      if (this.silentAudio) { try { this.silentAudio.pause(); } catch (e) {} }
    } else {
      // un-mute: re-enable silent audio for iOS
      if (this.silentAudio) { try { this.silentAudio.play(); } catch (e) {} }
    }
  }
}

const styles = `
/* Fonts loaded via <link> in index.html so the request fires during HTML parse,
   not after React mounts this <style>. Saves ~1s on 4G. */

.font-display { font-family: 'Bungee', sans-serif; letter-spacing: 0.02em; }
.font-shade { font-family: 'Bungee Shade', sans-serif; }
.font-body { font-family: 'Outfit', sans-serif; }

.halftone-bg {
  background-color: #0a0a0a;
  background-image:
    radial-gradient(circle at 25% 25%, rgba(220,38,38,0.25) 1.5px, transparent 2px),
    radial-gradient(circle at 75% 75%, rgba(127,29,29,0.4) 1.5px, transparent 2px),
    linear-gradient(135deg, #1a0a0a 0%, #0a0a0a 50%, #1a0606 100%);
  background-size: 24px 24px, 24px 24px, 100% 100%;
}

/* Stadium-style ring with crowd silhouette */
.ring-pov-bg {
  background:
    radial-gradient(ellipse at 50% 110%, rgba(252,211,77,0.30) 0%, transparent 45%),
    radial-gradient(ellipse at 50% -10%, rgba(255,255,255,0.10) 0%, transparent 45%),
    repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 8px),
    linear-gradient(180deg, #0a0606 0%, #1c0606 25%, #450a0a 55%, #7f1d1d 85%, #450a0a 100%);
}

/* Spotlight beams */
.spotlight {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 80% at 30% 20%, rgba(252,211,77,0.12) 0%, transparent 50%),
    radial-gradient(ellipse 60% 80% at 70% 20%, rgba(252,211,77,0.12) 0%, transparent 50%),
    radial-gradient(ellipse 80% 60% at 50% 80%, rgba(252,211,77,0.18) 0%, transparent 60%);
  pointer-events: none;
  z-index: 1;
}

.scanlines::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px);
  pointer-events: none;
  z-index: 50;
  mix-blend-mode: multiply;
}

@keyframes shake-cam {
  0%,100% { transform: translate(0,0); }
  10% { transform: translate(-12px, 6px); }
  25% { transform: translate(12px, -6px); }
  40% { transform: translate(-9px, -4px); }
  55% { transform: translate(9px, 4px); }
  70% { transform: translate(-5px, 5px); }
  85% { transform: translate(5px, -5px); }
}
.shake-cam { animation: shake-cam 0.55s ease-in-out; }

@keyframes shake-light {
  0%,100% { transform: translate(0,0); }
  25% { transform: translate(-4px, 2px); }
  75% { transform: translate(4px, -2px); }
}
.shake-light { animation: shake-light 0.3s ease-in-out; }

@keyframes shake { 0%,100% { transform: translate(0,0) rotate(0); } 25% { transform: translate(-8px, 3px) rotate(-2deg); } 50% { transform: translate(8px, -3px) rotate(2deg); } 75% { transform: translate(-5px, 2px) rotate(-1deg); } }
.shake { animation: shake 0.4s ease-in-out; }

@keyframes pop-comic {
  0% { transform: translate(-50%, -50%) scale(0) rotate(-20deg); opacity: 0; }
  25% { transform: translate(-50%, -50%) scale(1.5) rotate(-15deg); opacity: 1; }
  60% { transform: translate(-50%, -50%) scale(1.1) rotate(-12deg); opacity: 1; }
  100% { transform: translate(-50%, -50%) scale(1.4) rotate(-8deg); opacity: 0; }
}
.pop-comic { animation: pop-comic 0.7s ease-out forwards; }

@keyframes flash-white { 0%,100% { opacity: 0; } 40% { opacity: 1; } }
.flash-white { animation: flash-white 0.18s ease-out; }

@keyframes flash-red { 0%,100% { opacity: 0; } 30% { opacity: 0.7; } }
.flash-red { animation: flash-red 0.32s ease-out; }

@keyframes slide-up { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.slide-up { animation: slide-up 0.5s ease-out backwards; }

@keyframes pulse-danger {
  0%,100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.8), inset 0 0 20px rgba(220,38,38,0.4); }
  50% { box-shadow: 0 0 0 12px rgba(220,38,38,0), inset 0 0 30px rgba(220,38,38,0.6); }
}
.pulse-danger { animation: pulse-danger 0.9s infinite; }

@keyframes ko-fall-pov {
  0% { transform: translateY(0) rotate(0); opacity: 1; }
  20% { transform: translateY(-30px) rotate(0); }
  100% { transform: translateY(160px) rotate(15deg); opacity: 0.5; }
}
.ko-fall-pov { animation: ko-fall-pov 1.6s cubic-bezier(0.5, 0, 0.75, 0) forwards; }

@keyframes ko-stamp {
  0% { transform: translate(-50%, -50%) scale(8) rotate(-30deg); opacity: 0; }
  50% { transform: translate(-50%, -50%) scale(0.9) rotate(-12deg); opacity: 1; }
  100% { transform: translate(-50%, -50%) scale(1) rotate(-12deg); opacity: 1; }
}
.ko-stamp { animation: ko-stamp 0.7s cubic-bezier(0.5, 1.8, 0.5, 1) forwards; }

@keyframes blink { 0%,50%,100% { opacity: 1; } 25%,75% { opacity: 0.3; } }
.blink { animation: blink 0.8s infinite; }

@keyframes slide-stripe { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
.stripe-bg {
  background: repeating-linear-gradient(45deg, #fbbf24 0px, #fbbf24 10px, #0a0a0a 10px, #0a0a0a 20px);
  animation: slide-stripe 0.6s linear infinite;
}

@keyframes tell-pulse {
  0%,100% { filter: drop-shadow(0 0 8px var(--tell-color)) drop-shadow(0 0 18px var(--tell-color)); }
  50% { filter: drop-shadow(0 0 18px var(--tell-color)) drop-shadow(0 0 32px var(--tell-color)); }
}
.tell-pulse { animation: tell-pulse 0.32s ease-in-out infinite; }

@keyframes warn-bounce {
  0% { transform: translateX(-50%) translateY(0) scale(0); opacity: 0; }
  50% { transform: translateX(-50%) translateY(-8px) scale(1.2); opacity: 1; }
  100% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
}
.warn-bounce { animation: warn-bounce 0.22s ease-out forwards; }

@keyframes glove-charge {
  0%,100% { filter: drop-shadow(0 0 6px #fbbf24); }
  50% { filter: drop-shadow(0 0 22px #fbbf24); }
}
.glove-charging { animation: glove-charge 0.4s ease-in-out infinite; }

@keyframes blood-drip {
  0% { transform: translateY(-30px); opacity: 0; }
  20% { opacity: 0.85; }
  100% { transform: translateY(45vh); opacity: 0; }
}
.blood-drip { animation: blood-drip 1.4s ease-in forwards; }

@keyframes sweat-drop {
  0% { transform: translate(0, 0); opacity: 0.9; }
  100% { transform: translate(var(--dx, 0), 60px); opacity: 0; }
}
.sweat-drop { animation: sweat-drop 0.8s ease-in forwards; }

@keyframes spark-out {
  0% { transform: translate(0,0) scale(0.4); opacity: 1; }
  100% { transform: translate(var(--dx,0), var(--dy,0)) scale(1.2); opacity: 0; }
}
.spark-out { animation: spark-out 0.5s ease-out forwards; }

@keyframes crowd-bob {
  0%,100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
.crowd-bob { animation: crowd-bob 0.6s ease-in-out infinite; }

@keyframes intro-zoom {
  0% { transform: scale(0.3); opacity: 0; }
  60% { transform: scale(1.1); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.intro-zoom { animation: intro-zoom 0.6s cubic-bezier(0.5, 1.6, 0.5, 1) forwards; }

@keyframes round-banner {
  0% { transform: translateX(-100vw); }
  20% { transform: translateX(0); }
  80% { transform: translateX(0); }
  100% { transform: translateX(100vw); }
}
.round-banner { animation: round-banner 2.5s cubic-bezier(0.4, 0, 0.6, 1) forwards; }

.text-stroke-black { -webkit-text-stroke: 2px #0a0a0a; }
.text-stroke-thick { -webkit-text-stroke: 3px #0a0a0a; }

.btn-arcade {
  position: relative;
  border: 3px solid #0a0a0a;
  box-shadow: 0 5px 0 #0a0a0a, 0 5px 0 1px rgba(0,0,0,0.2);
  transition: transform 0.08s, box-shadow 0.08s;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.btn-arcade:active:not(:disabled),
.btn-arcade.held {
  transform: translateY(4px);
  box-shadow: 0 1px 0 #0a0a0a;
}
.btn-arcade:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-arcade.held.charging-active {
  box-shadow: 0 1px 0 #0a0a0a, inset 0 0 25px rgba(252,211,77,0.7), 0 0 22px rgba(252,211,77,0.5);
}

/* boss container animates position smoothly */
.boss-anchor { transition: transform 0.4s cubic-bezier(0.4, 0, 0.6, 1); }

/* player tilt for dodging */
.player-tilt { transition: transform 0.18s cubic-bezier(0.4, 0, 0.4, 1); }
`;

const HIT_TEXTS = ['POW!', 'BAM!', 'WHACK!', 'BOOM!', 'CRACK!', 'SMASH!', 'KAPOW!', 'THUD!'];
const MISS_TEXTS = ['MISS!', 'WHOOSH!', 'WHIFF!'];

const PLAYER_ATTACKS = {
  jab:      { label: 'JAB',   min: 7,  max: 12, acc: 1.0,  cooldown: 380,  stamina: 8 },
  hook:     { label: 'HOOK',  min: 16, max: 24, acc: 0.88, cooldown: 1000, stamina: 22 },
  uppercut: { label: 'UPPER', min: 26, max: 38, acc: 0.65, cooldown: 1800, stamina: 36 },
};

const BOSS_ATTACKS = {
  jab:      { min: 7,  max: 13, acc: 1.0,  tell: 420, color: '#fbbf24', label: 'JAB' },
  hook:     { min: 14, max: 22, acc: 0.92, tell: 660, color: '#f97316', label: 'HOOK' },
  uppercut: { min: 24, max: 36, acc: 0.72, tell: 1000, color: '#dc2626', label: 'UPPERCUT' },
};

// Level definitions: scale boss aggression, damage, tell windows
const LEVELS = [
  { lvl: 1, name: 'NOVICIO',     emoji: '🥉', tellMul: 1.20, dmgMul: 0.85, intMul: 1.15, color: '#84cc16' },
  { lvl: 2, name: 'AMATEUR',     emoji: '🥈', tellMul: 1.00, dmgMul: 1.00, intMul: 1.00, color: '#22d3ee' },
  { lvl: 3, name: 'PROFESIONAL', emoji: '🥇', tellMul: 0.85, dmgMul: 1.15, intMul: 0.85, color: '#fbbf24' },
  { lvl: 4, name: 'CONTENDIENTE',emoji: '🏆', tellMul: 0.72, dmgMul: 1.35, intMul: 0.72, color: '#f97316' },
  { lvl: 5, name: 'CAMPEÓN',     emoji: '👑', tellMul: 0.60, dmgMul: 1.55, intMul: 0.60, color: '#dc2626' },
  { lvl: 6, name: 'LEYENDA',     emoji: '💀', tellMul: 0.48, dmgMul: 1.80, intMul: 0.50, color: '#a855f7' },
];

const ROUND_DURATION = 60; // seconds
const ROUNDS_TO_WIN = 2;   // best of 3
const REST_DURATION = 8;   // seconds between rounds
const CHARGE_THRESHOLD = 300;
const STAMINA_REGEN = 22;
const STAMINA_BLOCK_DRAIN = 30;
const BOSS_INTERVAL_MIN = 850;
const BOSS_INTERVAL_MAX = 1900;
const BOSS_INTERVAL_RAGE_MIN = 550;
const BOSS_INTERVAL_RAGE_MAX = 1200;
const REST_HP_REGEN = 25; // HP restored between rounds

function damageLevel(hp) {
  if (hp >= 80) return 0;
  if (hp >= 60) return 1;
  if (hp >= 40) return 2;
  if (hp >= 20) return 3;
  if (hp > 0) return 4;
  return 5;
}

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- Damage overlay ----------
function DamageOverlay({ level, flipped }) {
  const id = flipped ? 'r' : 'l';
  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: flipped ? 'scaleX(-1)' : 'none' }}>
      <defs>
        <filter id={`blur-${id}`}><feGaussianBlur stdDeviation="0.6" /></filter>
      </defs>
      {level >= 1 && <ellipse cx="28" cy="58" rx="8" ry="5" fill="#dc2626" opacity="0.5" filter={`url(#blur-${id})`} />}
      {level >= 2 && (
        <>
          <ellipse cx="68" cy="42" rx="9" ry="6" fill="#4c1d95" opacity="0.75" filter={`url(#blur-${id})`} />
          <ellipse cx="68" cy="40" rx="3" ry="2" fill="#1e1b4b" opacity="0.9" />
        </>
      )}
      {level >= 3 && (
        <>
          <path d="M 60 30 L 75 36" stroke="#991b1b" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M 62 31 L 73 35" stroke="#fca5a5" strokeWidth="0.6" strokeLinecap="round" />
          <path d="M 50 56 Q 51 64 49 70 Q 47 73 50 73 Q 53 73 51 70 Q 49 64 50 56" fill="#dc2626" />
          <ellipse cx="50" cy="74" rx="2" ry="3" fill="#991b1b" />
        </>
      )}
      {level >= 4 && (
        <>
          <ellipse cx="32" cy="42" rx="9" ry="6" fill="#4c1d95" opacity="0.75" filter={`url(#blur-${id})`} />
          <ellipse cx="32" cy="40" rx="3" ry="2" fill="#1e1b4b" opacity="0.9" />
          <ellipse cx="50" cy="78" rx="11" ry="5" fill="#7f1d1d" opacity="0.7" filter={`url(#blur-${id})`} />
          <ellipse cx="72" cy="62" rx="6" ry="4" fill="#4c1d95" opacity="0.5" filter={`url(#blur-${id})`} />
          <path d="M 40 25 L 48 22" stroke="#991b1b" strokeWidth="1.4" strokeLinecap="round" />
          {/* sweat */}
          <ellipse cx="22" cy="20" rx="1.2" ry="2.4" fill="#bae6fd" opacity="0.85" />
          <ellipse cx="80" cy="22" rx="1.2" ry="2.4" fill="#bae6fd" opacity="0.85" />
        </>
      )}
      {level >= 5 && (
        <>
          <text x="32" y="46" fontSize="14" fontWeight="900" fill="#0a0a0a" textAnchor="middle">✕</text>
          <text x="68" y="46" fontSize="14" fontWeight="900" fill="#0a0a0a" textAnchor="middle">✕</text>
        </>
      )}
    </svg>
  );
}

// ---------- Crowd silhouette (SVG band with simple heads) ----------
function CrowdBand() {
  // generate ~30 heads at random heights
  const heads = Array.from({ length: 30 }, (_, i) => ({
    cx: 5 + (i / 29) * 90 + (Math.random() - 0.5) * 2,
    cy: 50 + (Math.random() - 0.5) * 8,
    r: 2.2 + Math.random() * 0.8,
    delay: Math.random() * 0.6,
  }));
  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="absolute top-0 left-0 w-full h-[18%] pointer-events-none z-[2]">
      <defs>
        <linearGradient id="crowdGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <rect x="0" y="20" width="100" height="40" fill="url(#crowdGrad)" />
      {heads.map((h, i) => (
        <g key={i} className="crowd-bob" style={{ animationDelay: `${h.delay}s`, transformOrigin: `${h.cx}% ${h.cy}%` }}>
          <circle cx={h.cx} cy={h.cy} r={h.r} fill="#0a0a0a" />
          <ellipse cx={h.cx} cy={h.cy + h.r * 1.3} rx={h.r * 1.4} ry={h.r * 1.1} fill="#0a0a0a" />
        </g>
      ))}
    </svg>
  );
}

// ---------- BOSS POV ----------
function BossPOV({ image, hp, knockedOut, hitFlashing, telling, tell, bossStrike, swayX, swayY, scaleZ, sweating }) {
  const level = damageLevel(hp);
  const gloveColor = '#1d4ed8';
  const shortColor = '#1d4ed8';

  const tellSide = tell?.side;
  const strikeSide = bossStrike?.side;

  function gloveTransform(side) {
    if (strikeSide === side) {
      const dir = side === 'left' ? 1 : -1;
      return `translate(${dir * 70}px, 90px) scale(3.6)`;
    }
    if (telling && tellSide === side) {
      const dir = side === 'left' ? -1 : 1;
      return `translate(${dir * 22}px, -30px) scale(0.88) rotate(${dir * 18}deg)`;
    }
    return 'translate(0, 0) scale(1)';
  }

  const tellStyle = telling ? { '--tell-color': tell ? BOSS_ATTACKS[tell.type].color : '#dc2626' } : {};

  return (
    <div
      className={`boss-anchor relative w-full h-full ${knockedOut ? 'ko-fall-pov' : ''}`}
      style={{
        transform: knockedOut ? undefined : `translate(${swayX}px, ${swayY}px) scale(${scaleZ})`,
        transformOrigin: 'center bottom',
      }}
    >
      <svg
        viewBox="0 0 400 500"
        preserveAspectRatio="xMidYMax slice"
        className={`absolute inset-0 w-full h-full ${telling ? 'tell-pulse' : ''}`}
        style={tellStyle}
      >
        <defs>
          <linearGradient id="skinGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fef9c3" />
            <stop offset="100%" stopColor="#fde68a" />
          </linearGradient>
          <linearGradient id="gloveGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="60%" stopColor={gloveColor} />
            <stop offset="100%" stopColor="#1e3a8a" />
          </linearGradient>
          <linearGradient id="shortGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#1e3a8a" />
          </linearGradient>
          <radialGradient id="muscleShade" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#fde68a" stopOpacity="0" />
            <stop offset="100%" stopColor="#92400e" stopOpacity="0.4" />
          </radialGradient>
        </defs>

        <ellipse cx="200" cy="495" rx="180" ry="10" fill="rgba(0,0,0,0.5)" />

        {/* legs/shorts */}
        <path d="M 30 380 L 370 380 L 390 500 L 10 500 Z" fill="url(#shortGrad)" stroke="#0a0a0a" strokeWidth="4" />
        <line x1="200" y1="380" x2="200" y2="500" stroke="#0a0a0a" strokeWidth="3" />
        {/* shorts side stripe */}
        <path d="M 30 380 L 35 410 L 25 440 L 10 500 L 35 500 L 50 440 L 55 410 L 50 380 Z" fill="#fbbf24" opacity="0.6" />
        <path d="M 370 380 L 365 410 L 375 440 L 390 500 L 365 500 L 350 440 L 345 410 L 350 380 Z" fill="#fbbf24" opacity="0.6" />

        {/* belt */}
        <rect x="20" y="368" width="360" height="22" fill="#fbbf24" stroke="#0a0a0a" strokeWidth="4" />
        <rect x="20" y="370" width="360" height="6" fill="#fde047" />
        <rect x="180" y="368" width="40" height="22" fill="#dc2626" stroke="#0a0a0a" strokeWidth="3" />
        <text x="200" y="385" fontSize="12" fontWeight="900" fill="#fbbf24" textAnchor="middle">★</text>

        {/* torso with shading */}
        <path d="M 50 200 Q 200 175 350 200 L 365 380 L 35 380 Z" fill="url(#skinGrad)" stroke="#0a0a0a" strokeWidth="4" />
        {/* pec definition */}
        <path d="M 90 215 Q 195 205 195 295 Q 145 305 90 290 Z" fill="#fcd34d" opacity="0.7" />
        <path d="M 205 295 Q 205 205 310 215 Q 310 290 255 305 Z" fill="#fcd34d" opacity="0.7" />
        <path d="M 90 215 Q 195 205 195 295" fill="none" stroke="#a16207" strokeWidth="2" opacity="0.4" />
        <path d="M 205 295 Q 205 205 310 215" fill="none" stroke="#a16207" strokeWidth="2" opacity="0.4" />
        {/* abs */}
        <line x1="200" y1="295" x2="200" y2="370" stroke="#a16207" strokeWidth="2" opacity="0.4" />
        <line x1="170" y1="315" x2="230" y2="315" stroke="#a16207" strokeWidth="1.5" opacity="0.3" />
        <line x1="170" y1="340" x2="230" y2="340" stroke="#a16207" strokeWidth="1.5" opacity="0.3" />
        {/* highlight */}
        <ellipse cx="200" cy="220" rx="80" ry="15" fill="#fef9c3" opacity="0.6" />

        {/* shoulders */}
        <ellipse cx="55" cy="215" rx="55" ry="42" fill="url(#skinGrad)" stroke="#0a0a0a" strokeWidth="4" />
        <ellipse cx="345" cy="215" rx="55" ry="42" fill="url(#skinGrad)" stroke="#0a0a0a" strokeWidth="4" />
        <ellipse cx="50" cy="200" rx="20" ry="8" fill="#fef9c3" opacity="0.7" />
        <ellipse cx="350" cy="200" rx="20" ry="8" fill="#fef9c3" opacity="0.7" />
        <ellipse cx="55" cy="245" rx="40" ry="20" fill="url(#muscleShade)" />
        <ellipse cx="345" cy="245" rx="40" ry="20" fill="url(#muscleShade)" />

        {/* upper arms */}
        <path d="M 30 215 Q 25 280 70 320 L 110 305 Q 90 240 78 215 Z" fill="url(#skinGrad)" stroke="#0a0a0a" strokeWidth="4" />
        <path d="M 370 215 Q 375 280 330 320 L 290 305 Q 310 240 322 215 Z" fill="url(#skinGrad)" stroke="#0a0a0a" strokeWidth="4" />
        {/* arm shading */}
        <path d="M 38 230 Q 45 290 75 315" fill="none" stroke="#92400e" strokeWidth="2" opacity="0.35" />
        <path d="M 362 230 Q 355 290 325 315" fill="none" stroke="#92400e" strokeWidth="2" opacity="0.35" />

        {/* neck */}
        <rect x="170" y="120" width="60" height="80" fill="#e8c39e" stroke="#0a0a0a" strokeWidth="3" />
        <rect x="170" y="170" width="60" height="30" fill="#c89878" />
        <line x1="200" y1="120" x2="200" y2="200" stroke="#a16207" strokeWidth="1.5" opacity="0.4" />

        {/* LEFT GLOVE */}
        <g
          style={{
            transform: gloveTransform('left'),
            transformOrigin: '70px 320px',
            transition: bossStrike ? 'transform 0.1s ease-out' : 'transform 0.18s ease-out',
          }}
        >
          <ellipse cx="70" cy="320" rx="62" ry="68" fill="url(#gloveGrad)" stroke="#0a0a0a" strokeWidth="4" />
          <ellipse cx="70" cy="345" rx="48" ry="32" fill="rgba(0,0,0,0.30)" />
          <ellipse cx="50" cy="298" rx="18" ry="12" fill="rgba(255,255,255,0.55)" />
          <path d="M 35 325 L 25 345 L 45 340 Z" fill={gloveColor} stroke="#0a0a0a" strokeWidth="3" />
          {/* lacing */}
          <path d="M 60 280 L 80 280 M 60 295 L 80 295 M 60 310 L 80 310" stroke="#0a0a0a" strokeWidth="1.5" />
          <path d="M 60 280 Q 70 287 80 280 Q 70 302 60 295 Q 70 302 80 295 Q 70 317 60 310 Q 70 317 80 310" fill="none" stroke="#fbbf24" strokeWidth="1.2" />
        </g>

        {/* RIGHT GLOVE */}
        <g
          style={{
            transform: gloveTransform('right'),
            transformOrigin: '330px 320px',
            transition: bossStrike ? 'transform 0.1s ease-out' : 'transform 0.18s ease-out',
          }}
        >
          <ellipse cx="330" cy="320" rx="62" ry="68" fill="url(#gloveGrad)" stroke="#0a0a0a" strokeWidth="4" />
          <ellipse cx="330" cy="345" rx="48" ry="32" fill="rgba(0,0,0,0.30)" />
          <ellipse cx="350" cy="298" rx="18" ry="12" fill="rgba(255,255,255,0.55)" />
          <path d="M 365 325 L 375 345 L 355 340 Z" fill={gloveColor} stroke="#0a0a0a" strokeWidth="3" />
          <path d="M 320 280 L 340 280 M 320 295 L 340 295 M 320 310 L 340 310" stroke="#0a0a0a" strokeWidth="1.5" />
          <path d="M 320 280 Q 330 287 340 280 Q 330 302 320 295 Q 330 302 340 295 Q 330 317 320 310 Q 330 317 340 310" fill="none" stroke="#fbbf24" strokeWidth="1.2" />
        </g>
      </svg>

      {/* Boss face */}
      <div
        className="absolute"
        style={{ top: '4%', left: '50%', transform: 'translateX(-50%)', width: '38%', aspectRatio: '1 / 1' }}
      >
        <div className="relative w-full h-full">
          <div
            className="absolute inset-0 rounded-full overflow-hidden border-[6px] border-yellow-400 shadow-[0_0_0_4px_#0a0a0a,0_10px_0_#0a0a0a]"
            style={{ filter: knockedOut ? 'grayscale(0.7) brightness(0.7)' : 'none' }}
          >
            <img src={image} alt="boss" className="w-full h-full object-cover" />
          </div>
          <DamageOverlay level={level} flipped={false} />
          {hitFlashing && <div className="absolute inset-0 rounded-full bg-white flash-white pointer-events-none" />}
          {/* sweat drops */}
          {sweating && Array.from({ length: 2 }, (_, i) => (
            <div
              key={`sweat-${sweating}-${i}`}
              className="absolute sweat-drop"
              style={{
                top: '35%',
                left: i === 0 ? '15%' : '85%',
                '--dx': i === 0 ? '-6px' : '6px',
              }}
            >
              <svg width="8" height="14" viewBox="0 0 8 14"><path d="M 4 0 Q 1 8 4 13 Q 7 8 4 0 Z" fill="#bae6fd" stroke="#0c4a6e" strokeWidth="0.5" /></svg>
            </div>
          ))}
        </div>
      </div>

      {tell && <TellWarning tell={tell} />}
    </div>
  );
}

function TellWarning({ tell }) {
  const a = BOSS_ATTACKS[tell.type];
  const total = a.tell;
  const elapsed = Date.now() - tell.startedAt;
  const pct = Math.min(100, (elapsed / total) * 100);
  return (
    <div key={tell.startedAt} className="absolute left-1/2 top-0 z-30 warn-bounce" style={{ transform: 'translateX(-50%)' }}>
      <div
        className="px-3 py-1 border-[3px] border-black font-display text-xs sm:text-sm text-black flex items-center gap-1 whitespace-nowrap"
        style={{ background: a.color, boxShadow: `0 0 18px ${a.color}` }}
      >
        ⚡ {a.label}! {tell.side === 'left' ? '↘' : '↙'}
      </div>
      <div className="h-1 bg-black/40 mt-1 mx-1">
        <div className="h-full bg-black" style={{ width: `${pct}%`, transition: 'width 60ms linear' }} />
      </div>
    </div>
  );
}

// ---------- Player gloves ----------
function PlayerGloves({ leftAnim, rightAnim, leftCharging, rightCharging, blocking, dodgeOffset }) {
  function gloveTransform(side, anim) {
    const dodge = side === 'left' ? -dodgeOffset * 0.5 : -dodgeOffset * 0.5;
    if (anim === 'jab') {
      const tx = side === 'left' ? 60 : -60;
      return `translate(${tx + dodge}px, -120px) scale(1.3) rotate(${side === 'left' ? -18 : 18}deg)`;
    }
    if (anim === 'power') {
      const tx = side === 'left' ? 80 : -80;
      return `translate(${tx + dodge}px, -180px) scale(1.7) rotate(${side === 'left' ? -28 : 28}deg)`;
    }
    if (blocking) {
      const tx = side === 'left' ? 50 : -50;
      return `translate(${tx + dodge}px, -100px) scale(1.15)`;
    }
    return `translate(${dodge}px, 0) scale(1)`;
  }

  return (
    <div className="absolute bottom-0 left-0 right-0 h-32 sm:h-40 pointer-events-none z-30 overflow-hidden">
      <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMax meet" className="w-full h-full">
        <defs>
          <linearGradient id="redGlove" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="60%" stopColor="#dc2626" />
            <stop offset="100%" stopColor="#7f1d1d" />
          </linearGradient>
        </defs>

        <g
          className={leftCharging ? 'glove-charging' : ''}
          style={{
            transform: gloveTransform('left', leftAnim),
            transformOrigin: '80px 200px',
            transition: 'transform 0.13s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <ellipse cx="80" cy="190" rx="80" ry="65" fill="url(#redGlove)" stroke="#0a0a0a" strokeWidth="5" />
          <ellipse cx="80" cy="205" rx="55" ry="35" fill="#7f1d1d" />
          <ellipse cx="58" cy="170" rx="20" ry="13" fill="rgba(255,255,255,0.55)" />
          <path d="M 30 180 Q 25 210 50 230 L 80 220 Q 60 195 50 175 Z" fill="#dc2626" stroke="#0a0a0a" strokeWidth="4" />
          {/* lacing */}
          <path d="M 65 145 L 95 145 M 65 165 L 95 165 M 65 185 L 95 185" stroke="#0a0a0a" strokeWidth="1.8" />
          <path d="M 65 145 Q 80 155 95 145 Q 80 175 65 165 Q 80 175 95 165 Q 80 195 65 185 Q 80 195 95 185" fill="none" stroke="#fbbf24" strokeWidth="1.4" />
          {leftCharging && <circle cx="80" cy="190" r="92" fill="none" stroke="#fbbf24" strokeWidth="3" strokeDasharray="6 4" opacity="0.85" />}
        </g>

        <g
          className={rightCharging ? 'glove-charging' : ''}
          style={{
            transform: gloveTransform('right', rightAnim),
            transformOrigin: '320px 200px',
            transition: 'transform 0.13s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <ellipse cx="320" cy="190" rx="80" ry="65" fill="url(#redGlove)" stroke="#0a0a0a" strokeWidth="5" />
          <ellipse cx="320" cy="205" rx="55" ry="35" fill="#7f1d1d" />
          <ellipse cx="342" cy="170" rx="20" ry="13" fill="rgba(255,255,255,0.55)" />
          <path d="M 370 180 Q 375 210 350 230 L 320 220 Q 340 195 350 175 Z" fill="#dc2626" stroke="#0a0a0a" strokeWidth="4" />
          <path d="M 305 145 L 335 145 M 305 165 L 335 165 M 305 185 L 335 185" stroke="#0a0a0a" strokeWidth="1.8" />
          <path d="M 305 145 Q 320 155 335 145 Q 320 175 305 165 Q 320 175 335 165 Q 320 195 305 185 Q 320 195 335 185" fill="none" stroke="#fbbf24" strokeWidth="1.4" />
          {rightCharging && <circle cx="320" cy="190" r="92" fill="none" stroke="#fbbf24" strokeWidth="3" strokeDasharray="6 4" opacity="0.85" />}
        </g>
      </svg>
    </div>
  );
}

// ---------- Impact sparks ----------
function ImpactSparks({ id, x, y }) {
  if (!id) return null;
  const sparks = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2;
    const dist = 30 + Math.random() * 30;
    return {
      key: `${id}-${i}`,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      color: pick(['#fbbf24', '#fde047', '#fff', '#fde68a']),
    };
  });
  return (
    <div className="absolute pointer-events-none z-40" style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}>
      {sparks.map((s) => (
        <div
          key={s.key}
          className="absolute spark-out"
          style={{ '--dx': `${s.dx}px`, '--dy': `${s.dy}px`, top: 0, left: 0 }}
        >
          <div className="w-2 h-2 rotate-45" style={{ background: s.color, boxShadow: `0 0 6px ${s.color}` }} />
        </div>
      ))}
    </div>
  );
}

// ---------- HP Bar ----------
function HPBarTop({ name, hp, side, avatar, isDanger }) {
  const segments = 14;
  const filledSegments = Math.ceil((hp / 100) * segments);
  const segs = Array.from({ length: segments }, (_, i) => i < filledSegments);
  if (side === 'right') segs.reverse();
  return (
    <div className={`flex ${side === 'right' ? 'flex-row-reverse' : 'flex-row'} items-center gap-2 flex-1`}>
      <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-full overflow-hidden border-[3px] border-yellow-400 shadow-[0_0_0_2px_#0a0a0a] flex-shrink-0 bg-gradient-to-b from-red-500 to-red-800 flex items-center justify-center">
        {avatar
          ? <img src={avatar} alt={name} className="w-full h-full object-cover" />
          : <span className="text-lg sm:text-xl">🥊</span>}
      </div>
      <div className={`flex-1 flex flex-col ${side === 'right' ? 'items-end' : 'items-start'} gap-0.5 min-w-0`}>
        <div className="font-display text-[10px] sm:text-xs text-yellow-300 text-stroke-black truncate max-w-full">{name}</div>
        <div className={`relative w-full h-3 sm:h-4 bg-black border-2 border-yellow-400 ${isDanger ? 'pulse-danger' : ''}`}>
          <div className="absolute inset-0.5 flex gap-[2px]">
            {segs.map((filled, i) => (
              <div key={i}
                className={`flex-1 transition-all duration-200 ${
                  filled
                    ? hp > 60 ? 'bg-gradient-to-b from-lime-400 to-green-600'
                    : hp > 30 ? 'bg-gradient-to-b from-yellow-300 to-orange-500'
                    : 'bg-gradient-to-b from-orange-500 to-red-700'
                    : 'bg-zinc-900'
                }`} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StaminaBar({ stamina }) {
  return (
    <div className="flex items-center gap-2 w-full">
      <span className="font-display text-[10px] text-blue-300">STAM</span>
      <div className="relative flex-1 h-2.5 bg-black border-2 border-blue-400">
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-400 to-blue-600 transition-all duration-100"
          style={{ width: `${stamina}%` }} />
      </div>
    </div>
  );
}

// ---------- Round/Timer header ----------
function RoundHeader({ round, timeLeft, playerWins, bossWins, level }) {
  const lvlData = LEVELS[level - 1];
  const dangerTime = timeLeft <= 10;
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <div className="flex items-center gap-1 font-display text-[10px] sm:text-xs">
        <span className="text-zinc-400">LVL</span>
        <span style={{ color: lvlData.color }}>{lvlData.emoji}{lvlData.lvl}</span>
      </div>
      <div className="flex items-center gap-2 font-display text-xs">
        <div className="flex gap-0.5">
          {Array.from({ length: ROUNDS_TO_WIN }, (_, i) => (
            <div key={`pw-${i}`} className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full border border-black ${i < playerWins ? 'bg-red-500' : 'bg-zinc-800'}`} />
          ))}
        </div>
        <div className="text-yellow-300 text-stroke-black">R{round}</div>
        <div className={`px-2 py-0.5 border-2 border-yellow-400 ${dangerTime ? 'bg-red-700 text-yellow-100 blink' : 'bg-black text-yellow-300'} font-display text-sm sm:text-base min-w-[44px] text-center`}>
          {String(Math.max(0, Math.ceil(timeLeft))).padStart(2, '0')}s
        </div>
        <div className="flex gap-0.5">
          {Array.from({ length: ROUNDS_TO_WIN }, (_, i) => (
            <div key={`bw-${i}`} className={`w-2 h-2 sm:w-3 sm:h-3 rounded-full border border-black ${i < bossWins ? 'bg-blue-500' : 'bg-zinc-800'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Combat log ----------
function CombatLog({ entries }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [entries]);
  return (
    <div ref={ref} className="bg-black/60 border-2 border-yellow-600 px-3 py-1 h-9 sm:h-10 overflow-y-auto font-body text-[10px] sm:text-[11px] text-zinc-300 leading-tight">
      {entries.length === 0 && <div className="text-zinc-600 italic">¡A pegar!</div>}
      {entries.map((e, i) => (
        <div key={i} className={i === entries.length - 1 ? 'text-yellow-300 font-bold' : ''}>{e}</div>
      ))}
    </div>
  );
}

// ---------- Camera FX ----------
function CameraFX({ playerHP, hitFlashing, blockFlashing, dripsKey }) {
  const intensity = Math.max(0, Math.min(1, (100 - playerHP) / 100));
  const drips = dripsKey ? Array.from({ length: 4 }, (_, i) => ({
    left: 5 + Math.random() * 90,
    delay: Math.random() * 0.2,
    size: 6 + Math.random() * 8,
    key: `${dripsKey}-${i}`,
  })) : [];
  return (
    <>
      <div
        className="absolute inset-0 pointer-events-none z-40 transition-opacity duration-300"
        style={{
          background: `radial-gradient(ellipse at center, transparent 30%, rgba(220,38,38,${0.65 * intensity}) 100%)`,
        }}
      />
      {hitFlashing && <div className="absolute inset-0 pointer-events-none z-45 bg-red-600 flash-red" />}
      {blockFlashing && <div className="absolute inset-0 pointer-events-none z-45 bg-blue-500 flash-red" />}
      {drips.map((d) => (
        <div key={d.key}
          className="absolute pointer-events-none z-46 blood-drip"
          style={{ left: `${d.left}%`, top: '-30px', animationDelay: `${d.delay}s` }}>
          <svg width={d.size * 2} height={d.size * 3} viewBox="0 0 20 30">
            <path d="M 10 0 Q 6 14 10 28 Q 14 14 10 0 Z" fill="#991b1b" />
            <ellipse cx="9" cy="6" rx="1.5" ry="3" fill="#fca5a5" opacity="0.6" />
          </svg>
        </div>
      ))}
    </>
  );
}

function ComicHit({ text, target }) {
  if (!text) return null;
  const top = target === 'boss' ? '28%' : '55%';
  return (
    <div className="absolute pointer-events-none z-40" style={{ left: '50%', top, transform: 'translate(-50%, -50%)' }}>
      <div className="pop-comic">
        <span className="font-shade text-6xl sm:text-8xl text-yellow-300 drop-shadow-[5px_5px_0_#0a0a0a]" style={{ display: 'block' }}>
          {text}
        </span>
      </div>
    </div>
  );
}

// ---------- Buttons ----------
function PunchButton({ side, label, powerLabel, color, onJab, onPower, jabCDRemaining, powerCDRemaining, stamina, jabCost, powerCost, disabled, onChargeChange }) {
  const downAtRef = useRef(0);
  const heldRef = useRef(false);
  const [showCharge, setShowCharge] = useState(false);
  const chargeTimerRef = useRef(null);

  const canJab = jabCDRemaining === 0 && stamina >= jabCost;
  const canPower = powerCDRemaining === 0 && stamina >= powerCost;
  const anyAvailable = canJab || canPower;

  useEffect(() => () => clearTimeout(chargeTimerRef.current), []);

  function pressDown() {
    if (disabled || !anyAvailable) return;
    heldRef.current = true;
    downAtRef.current = Date.now();
    setShowCharge(false);
    chargeTimerRef.current = setTimeout(() => {
      if (heldRef.current && canPower) {
        setShowCharge(true);
        onChargeChange?.(true);
      }
    }, CHARGE_THRESHOLD);
  }
  function pressUp() {
    if (!heldRef.current) return;
    const heldFor = Date.now() - downAtRef.current;
    heldRef.current = false;
    clearTimeout(chargeTimerRef.current);
    setShowCharge(false);
    onChargeChange?.(false);
    if (heldFor >= CHARGE_THRESHOLD && canPower) onPower();
    else if (canJab) onJab();
  }
  function pressCancel() {
    heldRef.current = false;
    clearTimeout(chargeTimerRef.current);
    setShowCharge(false);
    onChargeChange?.(false);
  }

  const showCD = powerCDRemaining > 0 || jabCDRemaining > 0;
  const cdValue = powerCDRemaining > 0 ? powerCDRemaining : jabCDRemaining;

  return (
    <button
      onPointerDown={pressDown}
      onPointerUp={pressUp}
      onPointerCancel={pressCancel}
      onPointerLeave={pressCancel}
      onContextMenu={(e) => e.preventDefault()}
      disabled={disabled || (!canJab && !canPower)}
      className={`btn-arcade ${color} text-black py-2 sm:py-3 font-display text-sm flex flex-col items-center justify-center leading-tight relative overflow-hidden ${showCharge ? 'charging-active' : ''}`}
    >
      <span className="text-lg">{side === 'left' ? '👊' : '🥊'}</span>
      <span className="text-[11px]">{side === 'left' ? '◀' : '▶'} {label}</span>
      <span className="text-[8px] opacity-80 font-body">
        {showCharge ? `¡SUELTA! ${powerLabel}` : `tap · hold=${powerLabel.toLowerCase()}`}
      </span>
      {showCD && (
        <div className="absolute inset-0 bg-black/55 pointer-events-none flex items-center justify-center">
          <span className="font-display text-white text-base">{(cdValue / 1000).toFixed(1)}s</span>
        </div>
      )}
      {!anyAvailable && cdValue === 0 && (
        <div className="absolute inset-0 bg-black/40 pointer-events-none flex items-center justify-center">
          <span className="font-display text-blue-300 text-[10px]">SIN STA</span>
        </div>
      )}
    </button>
  );
}

function DodgeButton({ direction, onPress, cdRemaining, disabled }) {
  const ready = cdRemaining === 0;
  return (
    <button
      onClick={() => ready && !disabled && onPress(direction)}
      disabled={!ready || disabled}
      className="btn-arcade bg-purple-400 text-black py-2 sm:py-3 font-display text-xs flex flex-col items-center justify-center leading-tight relative overflow-hidden"
    >
      <span className="text-lg">{direction === 'left' ? '⤺' : '⤻'}</span>
      <span className="text-[10px]">DODGE</span>
      <span className="text-[8px] opacity-80 font-body">{direction === 'left' ? 'izq' : 'der'}</span>
      {!ready && (
        <div className="absolute inset-0 bg-black/55 pointer-events-none flex items-center justify-center">
          <span className="font-display text-white text-sm">{(cdRemaining / 1000).toFixed(1)}s</span>
        </div>
      )}
    </button>
  );
}

// ---------- Upload screen ----------
function UploadScreen({ bossImg, bossName, setBossName, onUpload, onStart, selectedLevel, setSelectedLevel, onTestSound, audioReady }) {
  const ready = !!bossImg;
  const inputRef = useRef(null);
  return (
    <div className="halftone-bg scanlines relative min-h-screen flex flex-col items-center justify-center p-4 overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-3 stripe-bg" />
      <div className="absolute bottom-0 left-0 w-full h-3 stripe-bg" />
      <div className="relative z-10 w-full max-w-md flex flex-col items-center gap-4">
        <div className="text-center slide-up" style={{ animationDelay: '0.05s' }}>
          <div className="font-body text-xs tracking-[0.4em] text-yellow-300 mb-1">— TONIGHT'S MAIN EVENT —</div>
          <h1 className="font-shade text-6xl sm:text-7xl text-red-600 leading-none drop-shadow-[4px_4px_0_#0a0a0a]">
            BOSS<br />BOX
          </h1>
          <div className="font-body text-xs tracking-[0.3em] text-zinc-400 mt-1">★ FIRST-PERSON BRAWLER ★</div>
        </div>

        {/* Single boss upload card, larger */}
        <div className="w-full slide-up bg-blue-950 border-[3px] border-blue-500 shadow-[0_0_24px_rgba(37,99,235,0.55)] p-4 flex flex-col items-center gap-3" style={{ animationDelay: '0.2s' }}>
          <div className="font-display text-sm text-blue-400">SUBE LA CARA DE TU OPONENTE</div>
          <div className="font-body text-[11px] text-zinc-400 -mt-2">tu jefe, tu ex, quien sea</div>
          <button
            onClick={() => inputRef.current?.click()}
            className="relative w-36 h-36 sm:w-44 sm:h-44 rounded-full border-[5px] border-blue-500 overflow-hidden bg-zinc-900 flex items-center justify-center hover:scale-105 transition-transform shadow-[0_0_30px_rgba(37,99,235,0.6)]"
          >
            {bossImg ? <img src={bossImg} alt="boss" className="w-full h-full object-cover" /> : <span className="text-5xl">📷</span>}
          </button>
          <input ref={inputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
          <input type="text" value={bossName}
            onChange={(e) => setBossName(e.target.value.slice(0, 14).toUpperCase())}
            className="w-full max-w-[220px] text-center bg-black border-2 border-zinc-700 px-2 py-1.5 font-display text-sm text-yellow-300 focus:border-yellow-400 outline-none"
            placeholder="NOMBRE" />
        </div>

        {/* Level selector */}
        <div className="w-full slide-up" style={{ animationDelay: '0.3s' }}>
          <div className="font-display text-xs text-yellow-300 mb-2 text-center">DIFICULTAD</div>
          <div className="grid grid-cols-6 gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.lvl}
                onClick={() => setSelectedLevel(l.lvl)}
                className={`btn-arcade py-2 font-display text-xs flex flex-col items-center ${selectedLevel === l.lvl ? '' : 'opacity-60'}`}
                style={{ background: l.color }}
              >
                <span className="text-base">{l.emoji}</span>
                <span className="text-[9px] text-black">L{l.lvl}</span>
              </button>
            ))}
          </div>
          <div className="text-center font-body text-[11px] text-zinc-400 mt-1">
            {LEVELS[selectedLevel - 1].name}
          </div>
        </div>

        <button onClick={onTestSound}
          className="btn-arcade w-full py-2 px-4 font-display text-xs text-black bg-cyan-400 slide-up"
          style={{ animationDelay: '0.4s' }}>
          🔊 PROBAR SONIDO {audioReady ? '✓' : ''}
        </button>

        <button onClick={onStart} disabled={!ready}
          className={`btn-arcade w-full py-3 px-6 font-display text-xl sm:text-2xl text-white slide-up ${
            ready ? 'bg-red-600' : 'bg-zinc-700'
          }`} style={{ animationDelay: '0.45s' }}>
          {ready ? '🥊 ¡A LA LONA!' : 'SUBE UNA FOTO'}
        </button>

        <div className="font-body text-[10px] text-zinc-400 max-w-xs slide-up text-center leading-relaxed" style={{ animationDelay: '0.55s' }}>
          <div className="font-display text-yellow-300 text-xs mb-1">CÓMO JUGAR</div>
          <b>Tap</b> botón izq/der = jab. <b>Mantén</b> = HOOK / UPPERCUT.<br/>
          <b>BLOQUEA</b> los ⚡ del jefe. <b>DODGE</b> evita el daño completo.<br/>
          Best-of-3 rounds de 60s. Gana quien noquee o tenga más HP al final.
        </div>
        <div className="font-body text-[10px] text-orange-400 max-w-xs slide-up text-center leading-relaxed border-2 border-orange-700 p-2" style={{ animationDelay: '0.6s' }}>
          📱 <b>¿No oyes nada en iPhone?</b> Quita el switch de silencio (botón lateral) y sube el volumen multimedia.
        </div>
        <p className="font-body text-[10px] text-zinc-500 text-center max-w-xs">La foto queda en tu navegador.</p>
      </div>
    </div>
  );
}

// ============= REST INTERLUDE =============
function RestScreen({ countdown, playerName, bossName, bossImg, playerHP, bossHP, round, playerWins, bossWins }) {
  return (
    <div className="absolute inset-0 z-50 bg-black/85 flex flex-col items-center justify-center gap-4 p-4">
      <div className="font-shade text-4xl sm:text-5xl text-yellow-300 drop-shadow-[3px_3px_0_#0a0a0a] intro-zoom">
        DESCANSO
      </div>
      <div className="font-display text-base text-zinc-300">PRÓXIMO ROUND EN</div>
      <div className="font-shade text-7xl sm:text-8xl text-red-500 drop-shadow-[4px_4px_0_#0a0a0a]">
        {Math.ceil(countdown)}
      </div>
      <div className="grid grid-cols-2 gap-4 w-full max-w-md mt-2">
        {/* Player side */}
        <div className="flex flex-col items-center gap-2 p-3 border-[3px] border-red-500">
          <div className="w-16 h-16 rounded-full overflow-hidden border-[3px] border-yellow-400 bg-gradient-to-b from-red-500 to-red-800 flex items-center justify-center text-3xl">
            🥊
          </div>
          <div className="font-display text-xs text-yellow-300">{playerName}</div>
          <div className="font-display text-sm text-white">{Math.ceil(playerHP)} HP</div>
          <div className="flex gap-1">
            {Array.from({ length: ROUNDS_TO_WIN }, (_, j) => (
              <div key={j} className={`w-3 h-3 rounded-full border border-black ${j < playerWins ? 'bg-red-500' : 'bg-zinc-700'}`} />
            ))}
          </div>
        </div>
        {/* Boss side */}
        <div className="flex flex-col items-center gap-2 p-3 border-[3px] border-blue-500">
          <div className="w-16 h-16 rounded-full overflow-hidden border-[3px] border-yellow-400">
            <img src={bossImg} className="w-full h-full object-cover" alt="" />
          </div>
          <div className="font-display text-xs text-yellow-300">{bossName}</div>
          <div className="font-display text-sm text-white">{Math.ceil(bossHP)} HP</div>
          <div className="flex gap-1">
            {Array.from({ length: ROUNDS_TO_WIN }, (_, j) => (
              <div key={j} className={`w-3 h-3 rounded-full border border-black ${j < bossWins ? 'bg-blue-500' : 'bg-zinc-700'}`} />
            ))}
          </div>
        </div>
      </div>
      <div className="font-body text-xs text-zinc-400 mt-2">+{REST_HP_REGEN} HP regenerados</div>
      <div className="font-display text-base text-zinc-300 mt-3">ROUND {round + 1}</div>
    </div>
  );
}

// ============= MAIN =============
export default function BossBox() {
  const [phase, setPhase] = useState('upload'); // upload | fighting | resting | matchOver
  const [bossImg, setBossImg] = useState(null);
  const [bossName, setBossName] = useState('JEFE');
  const playerName = 'TÚ';
  const [selectedLevel, setSelectedLevel] = useState(3);
  const [currentLevel, setCurrentLevel] = useState(3);

  const [playerHP, setPlayerHP] = useState(100);
  const [bossHP, setBossHP] = useState(100);
  const [stamina, setStamina] = useState(100);
  const [round, setRound] = useState(1);
  const [playerWins, setPlayerWins] = useState(0);
  const [bossWins, setBossWins] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_DURATION);
  const [restCountdown, setRestCountdown] = useState(REST_DURATION);
  const [matchWinner, setMatchWinner] = useState(null);
  const [roundResult, setRoundResult] = useState(null); // 'player' | 'boss' | 'time-player' | 'time-boss' | 'time-draw'

  const [blocking, setBlocking] = useState(false);
  const [bossTell, setBossTell] = useState(null);
  const [bossStrike, setBossStrike] = useState(null);
  const [log, setLog] = useState([]);
  const [hitText, setHitText] = useState({ text: null, target: null });
  const [hitFlashBoss, setHitFlashBoss] = useState(false);
  const [hitFlashScreen, setHitFlashScreen] = useState(false);
  const [blockFlash, setBlockFlash] = useState(false);
  const [shakingScreen, setShakingScreen] = useState(false);
  const [shakingBoss, setShakingBoss] = useState(false);
  const [bloodKey, setBloodKey] = useState(null);
  const [sparksKey, setSparksKey] = useState(null);
  const [introCue, setIntroCue] = useState(false);
  const [showRoundBanner, setShowRoundBanner] = useState(false);
  const [sweatTrigger, setSweatTrigger] = useState(0);
  const [, setTickRender] = useState(0);

  // Boss positioning (sway/scale gives depth)
  const [bossSwayX, setBossSwayX] = useState(0);
  const [bossSwayY, setBossSwayY] = useState(0);
  const [bossScale, setBossScale] = useState(1);

  // Player dodge
  const [dodgeOffset, setDodgeOffset] = useState(0);
  const [playerTilt, setPlayerTilt] = useState(0);
  const [dodgeCD, setDodgeCD] = useState(0);
  const dodgeActiveRef = useRef(0); // timestamp until which dodge prevents damage

  // Audio
  const audioRef = useRef(null);
  const [muted, setMuted] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  // Create AudioEngine ONCE on mount (must not run during render — iOS Safari issue)
  useEffect(() => {
    if (!audioRef.current) audioRef.current = new AudioEngine();
  }, []);
  async function toggleMute() {
    const nm = !muted;
    setMuted(nm);
    if (!audioRef.current) audioRef.current = new AudioEngine();
    // Try to (re-)initialize audio in case it never got initialized
    if (!nm) {
      const ok = await audioRef.current.init();
      if (ok) setAudioReady(true);
    }
    audioRef.current.setMuted(nm);
  }

  const [leftAnim, setLeftAnim] = useState(null);
  const [rightAnim, setRightAnim] = useState(null);
  const [leftCharging, setLeftCharging] = useState(false);
  const [rightCharging, setRightCharging] = useState(false);

  const cdRef = useRef({ leftJab: 0, leftPower: 0, rightJab: 0, rightPower: 0 });
  const blockingRef = useRef(false);
  const bossTellRef = useRef(null);
  const bossNextAtRef = useRef(0);
  const introRef = useRef(false);
  const bossHPRef = useRef(100);
  const playerHPRef = useRef(100);
  const lastTickRef = useRef(Date.now());
  const phaseRef = useRef('upload');
  const matchOverRef = useRef(false);
  const roundEndedRef = useRef(false);
  const swayPhaseRef = useRef(0);
  const recentPlayerSideRef = useRef([]); // tracks last attacks for AI
  const comboCountRef = useRef(0); // boss combo counter

  useEffect(() => { blockingRef.current = blocking; }, [blocking]);
  useEffect(() => { bossTellRef.current = bossTell; }, [bossTell]);
  useEffect(() => { introRef.current = introCue; }, [introCue]);
  useEffect(() => { bossHPRef.current = bossHP; }, [bossHP]);
  useEffect(() => { playerHPRef.current = playerHP; }, [playerHP]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  function pushLog(line) { setLog((p) => [...p.slice(-30), line]); }

  function showHitOnBoss(text, isPower) {
    setHitText({ text, target: 'boss' });
    setHitFlashBoss(true);
    setShakingBoss(true);
    setSparksKey(Date.now());
    if (isPower) setShakingScreen(true);
    setTimeout(() => setHitFlashBoss(false), 200);
    setTimeout(() => setShakingBoss(false), 450);
    setTimeout(() => setShakingScreen(false), 350);
    setTimeout(() => setHitText({ text: null, target: null }), 750);
    if (Math.random() < 0.4) setSweatTrigger(Date.now());
  }

  function showHitOnPlayer(text, isPower) {
    setHitText({ text, target: 'player' });
    setHitFlashScreen(true);
    setShakingScreen(true);
    setBloodKey(Date.now());
    setTimeout(() => setHitFlashScreen(false), 320);
    setTimeout(() => setShakingScreen(false), 550);
    setTimeout(() => setHitText({ text: null, target: null }), 750);
  }

  function showBlock() {
    setBlockFlash(true);
    setShakingScreen(true);
    setSparksKey(Date.now());
    setTimeout(() => setBlockFlash(false), 320);
    setTimeout(() => setShakingScreen(false), 350);
  }

  function handleUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => setBossImg(e.target.result);
    reader.readAsDataURL(file);
  }

  async function startMatch() {
    // Initialize audio (user gesture required) FIRST so first round bell plays
    if (!audioRef.current) audioRef.current = new AudioEngine();
    const ok = await audioRef.current.init();
    if (ok) {
      setAudioReady(true);
      audioRef.current.bell(); // ding! confirms audio works
    }
    setCurrentLevel(selectedLevel);
    setPlayerHP(100); setBossHP(100); setStamina(100);
    setRound(1); setPlayerWins(0); setBossWins(0);
    setMatchWinner(null); setRoundResult(null);
    matchOverRef.current = false;
    startRound(1);
  }

  function startRound(roundNum) {
    setRound(roundNum);
    setStamina(100);
    setBlocking(false); setBossTell(null); setBossStrike(null);
    setLog([]);
    setRoundResult(null);
    roundEndedRef.current = false;
    cdRef.current = { leftJab: 0, leftPower: 0, rightJab: 0, rightPower: 0 };
    setDodgeCD(0);
    comboCountRef.current = 0;
    recentPlayerSideRef.current = [];
    bossNextAtRef.current = Date.now() + 2000;
    setTimeLeft(ROUND_DURATION);
    setPhase('fighting');
    setIntroCue(true);
    setShowRoundBanner(true);
    setTimeout(() => setIntroCue(false), 1400);
    setTimeout(() => setShowRoundBanner(false), 2500);
    // Audio: bell + start music
    audioRef.current?.bell();
    setTimeout(() => audioRef.current?.startMusic(), 600);
  }

  function endRound(result) {
    if (roundEndedRef.current) return;
    roundEndedRef.current = true;
    setRoundResult(result);
    setBossTell(null);
    setBlocking(false);

    // Audio: stop music + ring final bell + sting
    audioRef.current?.stopMusic();
    audioRef.current?.bell();
    if (result === 'player') setTimeout(() => audioRef.current?.ko(), 200);
    else if (result === 'boss') setTimeout(() => audioRef.current?.ko(), 200);

    // Determine winner of round
    let pw = playerWins, bw = bossWins;
    if (result === 'player' || result === 'time-player') pw += 1;
    else if (result === 'boss' || result === 'time-boss') bw += 1;
    // 'time-draw': no one gets a point

    setPlayerWins(pw); setBossWins(bw);

    // Check match end
    if (pw >= ROUNDS_TO_WIN) {
      setMatchWinner('player');
      matchOverRef.current = true;
      setTimeout(() => audioRef.current?.victory(), 1500);
      setTimeout(() => setPhase('matchOver'), 1800);
      return;
    }
    if (bw >= ROUNDS_TO_WIN) {
      setMatchWinner('boss');
      matchOverRef.current = true;
      setTimeout(() => audioRef.current?.defeat(), 1500);
      setTimeout(() => setPhase('matchOver'), 1800);
      return;
    }
    if (round >= 3) {
      // 3 rounds done, no clear winner — pick by total wins
      if (pw > bw) { setMatchWinner('player'); setTimeout(() => audioRef.current?.victory(), 1500); }
      else if (bw > pw) { setMatchWinner('boss'); setTimeout(() => audioRef.current?.defeat(), 1500); }
      else setMatchWinner('draw');
      matchOverRef.current = true;
      setTimeout(() => setPhase('matchOver'), 1800);
      return;
    }

    // Otherwise go to rest
    setTimeout(() => {
      // Regen HP
      setPlayerHP((hp) => Math.min(100, hp + REST_HP_REGEN));
      setBossHP((hp) => Math.min(100, hp + REST_HP_REGEN));
      setRestCountdown(REST_DURATION);
      setPhase('resting');
    }, 1800);
  }

  function reset() { setPhase('upload'); }

  function scheduleNextBoss(now) {
    const lvl = LEVELS[currentLevel - 1];
    // If in combo, queue next attack very fast
    if (comboCountRef.current > 0) {
      comboCountRef.current -= 1;
      bossNextAtRef.current = now + rand(280, 440);
      return;
    }
    const rage = bossHPRef.current < 30;
    const min = (rage ? BOSS_INTERVAL_RAGE_MIN : BOSS_INTERVAL_MIN) * lvl.intMul;
    const max = (rage ? BOSS_INTERVAL_RAGE_MAX : BOSS_INTERVAL_MAX) * lvl.intMul;
    bossNextAtRef.current = now + rand(min, max);

    // Roll for combo: chance scales with level. Combos = 1-2 follow-up jabs.
    const comboChance = lvl.lvl >= 3 ? 0.08 + (lvl.lvl - 3) * 0.07 : 0;
    if (Math.random() < comboChance) {
      comboCountRef.current = lvl.lvl >= 5 ? 2 : 1;
    }
  }

  // Player attack
  function performPlayerAttack(type, side) {
    if (matchOverRef.current || introRef.current || roundEndedRef.current) return;
    const a = PLAYER_ATTACKS[type];
    const now = Date.now();
    const cdKey = type === 'jab' ? `${side}Jab` : `${side}Power`;
    if (now < cdRef.current[cdKey]) return;
    if (stamina < a.stamina) return;

    cdRef.current[cdKey] = now + a.cooldown;
    setStamina((s) => Math.max(0, s - a.stamina));

    // Audio
    audioRef.current?.punch();

    // Track patterns for boss AI
    recentPlayerSideRef.current = [...recentPlayerSideRef.current.slice(-4), side];

    const animType = type === 'jab' ? 'jab' : 'power';
    if (side === 'left') {
      setLeftAnim(animType);
      setTimeout(() => setLeftAnim(null), 180);
    } else {
      setRightAnim(animType);
      setTimeout(() => setRightAnim(null), 180);
    }

    if (Math.random() < a.acc) {
      const dmg = randInt(a.min, a.max);
      setBossHP((prev) => Math.max(0, prev - dmg));
      setTimeout(() => { showHitOnBoss(pick(HIT_TEXTS), type !== 'jab'); audioRef.current?.hit(type !== 'jab'); }, 90);
      pushLog(`💥 ${a.label} ${side === 'left' ? '◀' : '▶'} → -${dmg} HP`);
      // Knock boss back briefly
      setBossSwayY(8);
      setTimeout(() => setBossSwayY(0), 250);
    } else {
      setTimeout(() => showHitOnBoss(pick(MISS_TEXTS), false), 90);
      pushLog(`💨 ${a.label} fallado`);
    }
  }

  // Dodge
  function performDodge(direction) {
    if (matchOverRef.current || introRef.current || roundEndedRef.current) return;
    if (Date.now() < dodgeCD) return;
    cdRef.current.lastDodge = Date.now();
    setDodgeCD(Date.now() + 1500);
    dodgeActiveRef.current = Date.now() + 350; // 350ms i-frame window
    audioRef.current?.dodge();
    const offset = direction === 'left' ? -120 : 120;
    setDodgeOffset(offset);
    setPlayerTilt(direction === 'left' ? -8 : 8);
    setTimeout(() => {
      setDodgeOffset(0);
      setPlayerTilt(0);
    }, 320);
    pushLog(`💨 Esquive ${direction === 'left' ? '←' : '→'}`);
  }

  // Boss landing
  function resolveBossHit(tell) {
    if (matchOverRef.current || roundEndedRef.current) return;
    setBossStrike({ side: tell.side, type: tell.type });
    setTimeout(() => setBossStrike(null), 280);
    audioRef.current?.punch();

    const a = BOSS_ATTACKS[tell.type];
    const lvl = LEVELS[currentLevel - 1];
    const blocked = blockingRef.current;
    const inDodge = Date.now() < dodgeActiveRef.current;
    let landed = Math.random() < a.acc;

    if (inDodge) {
      pushLog(`💨 ¡ESQUIVAS ${a.label}!`);
      setHitText({ text: 'DODGE!', target: 'player' });
      setTimeout(() => setHitText({ text: null, target: null }), 700);
      return;
    }
    if (!landed) {
      pushLog(`💨 Esquivas ${a.label} de ${bossName}`);
      setHitText({ text: pick(MISS_TEXTS), target: 'player' });
      setTimeout(() => setHitText({ text: null, target: null }), 700);
      return;
    }
    let dmg = Math.floor(randInt(a.min, a.max) * lvl.dmgMul);
    if (blocked) {
      dmg = Math.max(1, Math.floor(dmg * 0.18));
      showBlock();
      audioRef.current?.block();
      setHitText({ text: 'BLOCK!', target: 'player' });
      setTimeout(() => setHitText({ text: null, target: null }), 700);
      pushLog(`🛡️ Bloqueas ${a.label}: -${dmg} HP`);
    } else {
      showHitOnPlayer(pick(HIT_TEXTS), tell.type !== 'jab');
      audioRef.current?.hit(tell.type !== 'jab');
      pushLog(`😡 ${bossName} conecta ${a.label}: -${dmg} HP`);
    }
    setPlayerHP((prev) => Math.max(0, prev - dmg));
  }

  // Boss attack picker (AI-ish: at higher levels, target side player just attacked from)
  function pickBossAttack() {
    const lvl = LEVELS[currentLevel - 1];
    const rage = bossHPRef.current < 35;
    let type;
    // During combo: always jab (fast follow-up)
    if (comboCountRef.current > 0) {
      type = 'jab';
    } else {
      const r = Math.random();
      if (rage) type = r < 0.30 ? 'jab' : r < 0.65 ? 'hook' : 'uppercut';
      else type = r < 0.50 ? 'jab' : r < 0.82 ? 'hook' : 'uppercut';
    }

    let side;
    // Higher levels: stronger chance to attack the side player just attacked from
    const recent = recentPlayerSideRef.current;
    const predictChance = lvl.lvl >= 3 ? 0.30 + 0.12 * (lvl.lvl - 3) : 0.15;
    if (recent.length >= 1 && Math.random() < predictChance) {
      side = recent[recent.length - 1];
    } else {
      side = Math.random() < 0.5 ? 'left' : 'right';
    }
    // Apply level tell multiplier — but combo jabs get an extra speed bonus
    let baseTell = BOSS_ATTACKS[type].tell;
    if (comboCountRef.current > 0) baseTell *= 0.75;
    const finalTell = baseTell * lvl.tellMul;
    return { type, side, tellMs: finalTell };
  }

  // Game loop
  useEffect(() => {
    if (phase !== 'fighting') return;
    let raf;
    lastTickRef.current = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(0.1, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;

      if (matchOverRef.current || introRef.current || roundEndedRef.current) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Time
      setTimeLeft((t) => {
        const newT = t - dt;
        if (newT <= 0) {
          // Round time up — winner by HP
          const ph = playerHPRef.current, bh = bossHPRef.current;
          if (ph > bh) endRound('time-player');
          else if (bh > ph) endRound('time-boss');
          else endRound('time-draw');
          return 0;
        }
        return newT;
      });

      // Stamina
      if (blockingRef.current) {
        setStamina((s) => Math.max(0, s - STAMINA_BLOCK_DRAIN * dt));
      } else {
        setStamina((s) => Math.min(100, s + STAMINA_REGEN * dt));
      }

      // Boss sway (idle bobbing) + scale breathing
      swayPhaseRef.current += dt;
      const sx = Math.sin(swayPhaseRef.current * 1.2) * 18;
      const sc = 1 + Math.sin(swayPhaseRef.current * 0.8) * 0.04;
      setBossSwayX(sx);
      setBossScale(sc);

      // Dodge cooldown render
      setTickRender((t) => (t + 1) % 1000000);

      // Boss attack scheduler
      const tell = bossTellRef.current;
      if (tell) {
        if (now >= tell.hitsAt) {
          resolveBossHit(tell);
          setBossTell(null);
          scheduleNextBoss(now);
        }
      } else if (now >= bossNextAtRef.current) {
        const choice = pickBossAttack();
        setBossTell({ type: choice.type, side: choice.side, startedAt: now, hitsAt: now + choice.tellMs });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, currentLevel]);

  // Rest countdown
  useEffect(() => {
    if (phase !== 'resting') return;
    let raf;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      setRestCountdown((c) => {
        const nc = c - dt;
        if (nc <= 0) {
          startRound(round + 1);
          return 0;
        }
        return nc;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, round]);

  useEffect(() => {
    if (stamina <= 0 && blocking) setBlocking(false);
  }, [stamina, blocking]);

  // Round-ending KO detection
  useEffect(() => {
    if (phase !== 'fighting' || roundEndedRef.current) return;
    if (playerHP <= 0) {
      pushLog(`💀 ${bossName} gana el round por K.O.`);
      endRound('boss');
    } else if (bossHP <= 0) {
      pushLog(`🏆 Ganas el round por K.O.`);
      endRound('player');
    }
  }, [playerHP, bossHP, phase]);

  const handleBlockDown = useCallback(() => {
    if (matchOverRef.current || introRef.current || roundEndedRef.current) return;
    setBlocking(true);
  }, []);
  const handleBlockUp = useCallback(() => setBlocking(false), []);

  // ===== UPLOAD =====
  if (phase === 'upload') {
    return (
      <>
        <style>{styles}</style>
        <UploadScreen
          bossImg={bossImg}
          bossName={bossName}
          setBossName={setBossName}
          onUpload={handleUpload} onStart={startMatch}
          selectedLevel={selectedLevel} setSelectedLevel={setSelectedLevel}
          audioReady={audioReady}
          onTestSound={async () => {
            if (!audioRef.current) audioRef.current = new AudioEngine();
            const ok = await audioRef.current.init();
            if (ok) {
              setAudioReady(true);
              audioRef.current.bell();
              setTimeout(() => audioRef.current.punch(), 600);
              setTimeout(() => audioRef.current.hit(true), 800);
            }
          }}
        />
      </>
    );
  }

  // ===== MATCH OVER =====
  if (phase === 'matchOver') {
    const won = matchWinner === 'player';
    const draw = matchWinner === 'draw';
    const lvlData = LEVELS[currentLevel - 1];
    return (
      <>
        <style>{styles}</style>
        <div className="halftone-bg scanlines relative min-h-screen flex flex-col items-center justify-center p-4 gap-5">
          <div className="absolute top-0 left-0 right-0 h-3 stripe-bg z-50" />
          <div className="absolute bottom-0 left-0 right-0 h-3 stripe-bg z-50" />
          <div className="font-shade text-7xl sm:text-8xl text-yellow-300 drop-shadow-[5px_5px_0_#0a0a0a] intro-zoom text-center">
            {draw ? 'EMPATE' : won ? 'VICTORIA' : 'DERROTA'}
          </div>
          <div className="font-display text-base text-zinc-300">
            {draw ? 'Pelea cerrada' : won ? `${playerName} vence al ${lvlData.name}` : `${bossName} te puso a dormir`}
          </div>
          <div className="grid grid-cols-2 gap-4 w-full max-w-md">
            {[
              { name: playerName, img: null, isPlayer: true, hp: playerHP, wins: playerWins, color: 'red', winner: matchWinner === 'player' },
              { name: bossName, img: bossImg, isPlayer: false, hp: bossHP, wins: bossWins, color: 'blue', winner: matchWinner === 'boss' },
            ].map((p, i) => (
              <div key={i} className={`flex flex-col items-center gap-2 p-3 border-[3px] ${p.winner ? 'border-yellow-400 shadow-[0_0_20px_rgba(252,211,77,0.6)]' : (p.color === 'red' ? 'border-red-500' : 'border-blue-500')}`}>
                <div className={`w-20 h-20 rounded-full overflow-hidden border-[3px] ${p.winner ? 'border-yellow-400' : 'border-zinc-500'} ${p.isPlayer ? 'bg-gradient-to-b from-red-500 to-red-800 flex items-center justify-center' : ''}`}
                  style={{ filter: p.winner ? 'none' : 'grayscale(0.6)' }}>
                  {p.isPlayer
                    ? <span className="text-4xl">🥊</span>
                    : <img src={p.img} className="w-full h-full object-cover" alt="" />}
                </div>
                <div className="font-display text-sm text-yellow-300">{p.name}</div>
                <div className="flex gap-1">
                  {Array.from({ length: ROUNDS_TO_WIN }, (_, j) => (
                    <div key={j} className={`w-3 h-3 rounded-full border border-black ${j < p.wins ? (p.color === 'red' ? 'bg-red-500' : 'bg-blue-500') : 'bg-zinc-700'}`} />
                  ))}
                </div>
                {p.winner && <div className="font-shade text-xl text-yellow-300">👑</div>}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 w-full max-w-md">
            {won && currentLevel < 6 && (
              <button onClick={() => { setSelectedLevel(currentLevel + 1); startMatch(); }}
                className="btn-arcade bg-yellow-400 text-black py-3 font-display text-sm col-span-2"
                style={{ background: LEVELS[currentLevel].color }}>
                ⬆️ SUBIR A {LEVELS[currentLevel].emoji} {LEVELS[currentLevel].name}
              </button>
            )}
            <button onClick={startMatch}
              className="btn-arcade bg-yellow-400 text-black py-3 font-display text-sm">
              🔁 REVANCHA
            </button>
            <button onClick={reset}
              className="btn-arcade bg-red-600 text-white py-3 font-display text-sm">
              📷 NUEVAS FOTOS
            </button>
          </div>
        </div>
      </>
    );
  }

  // ===== Build button cooldown data =====
  const now = Date.now();
  const cd = cdRef.current;
  const cdData = {
    leftJab: Math.max(0, cd.leftJab - now),
    leftPower: Math.max(0, cd.leftPower - now),
    rightJab: Math.max(0, cd.rightJab - now),
    rightPower: Math.max(0, cd.rightPower - now),
  };
  const dodgeRemaining = Math.max(0, dodgeCD - now);

  // ===== FIGHTING / RESTING =====
  return (
    <>
      <style>{styles}</style>
      <div className="ring-pov-bg scanlines relative min-h-screen flex flex-col p-2 sm:p-3 gap-1.5 overflow-hidden">
        <div className="spotlight" />
        <div className="absolute top-0 left-0 right-0 h-2 stripe-bg z-50" />
        <div className="absolute bottom-0 left-0 right-0 h-2 stripe-bg z-50" />
        <CrowdBand />

        {/* Mute toggle */}
        <button
          onClick={toggleMute}
          className="absolute top-3 right-3 z-[60] w-9 h-9 rounded-full bg-black/70 border-2 border-yellow-400 flex items-center justify-center text-base hover:scale-110 transition-transform"
          aria-label={muted ? 'Activar sonido' : 'Silenciar'}
        >
          {muted ? '🔇' : '🔊'}
        </button>

        {/* Round + timer header */}
        <div className="relative z-30 mt-1 pr-12">
          <RoundHeader round={round} timeLeft={timeLeft} playerWins={playerWins} bossWins={bossWins} level={currentLevel} />
        </div>

        {/* HP bars */}
        <div className="relative z-30 flex items-center gap-2">
          <HPBarTop name={playerName} hp={playerHP} side="left" avatar={null}
            isDanger={playerHP > 0 && playerHP <= 25} />
          <HPBarTop name={bossName} hp={bossHP} side="right" avatar={bossImg}
            isDanger={bossHP > 0 && bossHP <= 25} />
        </div>

        <div className="relative z-30 px-1">
          <StaminaBar stamina={stamina} />
        </div>

        {/* Main fight area */}
        <div className={`relative flex-1 z-10 overflow-hidden min-h-[280px] ${shakingScreen ? 'shake-cam' : ''}`}>
          <div
            className={`absolute inset-0 player-tilt ${shakingBoss && !shakingScreen ? 'shake' : ''}`}
            style={{ transform: `translateX(${dodgeOffset}px) rotate(${playerTilt}deg)` }}
          >
            <BossPOV
              image={bossImg}
              hp={bossHP}
              knockedOut={roundResult === 'player' && phase === 'fighting'}
              hitFlashing={hitFlashBoss}
              telling={!!bossTell}
              tell={bossTell}
              bossStrike={bossStrike}
              swayX={bossSwayX}
              swayY={bossSwayY}
              scaleZ={bossScale}
              sweating={sweatTrigger}
            />
          </div>

          <PlayerGloves
            leftAnim={leftAnim} rightAnim={rightAnim}
            leftCharging={leftCharging} rightCharging={rightCharging}
            blocking={blocking} dodgeOffset={dodgeOffset}
          />

          <CameraFX
            playerHP={playerHP} hitFlashing={hitFlashScreen}
            blockFlashing={blockFlash} dripsKey={bloodKey}
          />

          <ImpactSparks id={sparksKey} x={50} y={hitText.target === 'boss' ? 32 : 55} />

          <ComicHit text={hitText.text} target={hitText.target} />

          {/* Round banner */}
          {showRoundBanner && (
            <div className="absolute inset-x-0 top-1/3 z-50 flex items-center justify-center">
              <div className="round-banner bg-black/85 border-y-4 border-yellow-400 px-8 py-3 w-full text-center">
                <div className="font-shade text-4xl sm:text-5xl text-yellow-300 drop-shadow-[3px_3px_0_#0a0a0a]">
                  ROUND {round}
                </div>
                <div className="font-display text-xs text-zinc-300 mt-1">
                  {LEVELS[currentLevel - 1].emoji} {LEVELS[currentLevel - 1].name}
                </div>
              </div>
            </div>
          )}

          {introCue && !showRoundBanner && (
            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/40">
              <div className="ko-stamp font-shade text-7xl sm:text-8xl text-red-500 drop-shadow-[4px_4px_0_#0a0a0a]">
                FIGHT!
              </div>
            </div>
          )}

          {roundResult && (
            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/70">
              <div className="ko-stamp font-shade text-5xl sm:text-7xl text-yellow-300 drop-shadow-[4px_4px_0_#0a0a0a] text-center">
                {roundResult === 'player' && 'K.O.! ¡GANAS!'}
                {roundResult === 'boss' && 'K.O.! PIERDES'}
                {roundResult === 'time-player' && '¡ROUND TUYO!'}
                {roundResult === 'time-boss' && 'ROUND DEL JEFE'}
                {roundResult === 'time-draw' && 'EMPATE EN HP'}
              </div>
            </div>
          )}

          {/* Resting overlay */}
          {phase === 'resting' && (
            <RestScreen
              countdown={restCountdown}
              playerName={playerName} bossName={bossName}
              bossImg={bossImg}
              playerHP={playerHP} bossHP={bossHP}
              round={round} playerWins={playerWins} bossWins={bossWins}
            />
          )}
        </div>

        <CombatLog entries={log} />

        {/* Controls */}
        <div className="grid grid-cols-3 gap-1.5 z-20">
          <PunchButton
            side="left" label="JAB" powerLabel="HOOK" color="bg-yellow-400"
            onJab={() => performPlayerAttack('jab', 'left')}
            onPower={() => performPlayerAttack('hook', 'left')}
            jabCDRemaining={cdData.leftJab} powerCDRemaining={cdData.leftPower}
            stamina={stamina}
            jabCost={PLAYER_ATTACKS.jab.stamina} powerCost={PLAYER_ATTACKS.hook.stamina}
            disabled={phase === 'resting' || roundEndedRef.current}
            onChargeChange={setLeftCharging}
          />
          <button
            onPointerDown={handleBlockDown}
            onPointerUp={handleBlockUp}
            onPointerCancel={handleBlockUp}
            onPointerLeave={handleBlockUp}
            onContextMenu={(e) => e.preventDefault()}
            disabled={phase === 'resting' || roundEndedRef.current || stamina <= 0}
            className={`btn-arcade ${blocking ? 'held bg-blue-300' : 'bg-zinc-300'} text-black py-2 sm:py-3 font-display text-sm flex flex-col items-center justify-center leading-tight relative overflow-hidden`}
          >
            <span className="text-lg">🛡️</span>
            <span className="text-[11px]">BLOQUEO</span>
            <span className="text-[8px] opacity-80 font-body">mantén · -82%</span>
          </button>
          <PunchButton
            side="right" label="JAB" powerLabel="UPPER" color="bg-orange-500"
            onJab={() => performPlayerAttack('jab', 'right')}
            onPower={() => performPlayerAttack('uppercut', 'right')}
            jabCDRemaining={cdData.rightJab} powerCDRemaining={cdData.rightPower}
            stamina={stamina}
            jabCost={PLAYER_ATTACKS.jab.stamina} powerCost={PLAYER_ATTACKS.uppercut.stamina}
            disabled={phase === 'resting' || roundEndedRef.current}
            onChargeChange={setRightCharging}
          />
        </div>

        {/* Dodge row */}
        <div className="grid grid-cols-2 gap-1.5 z-20">
          <DodgeButton direction="left" onPress={performDodge} cdRemaining={dodgeRemaining} disabled={phase === 'resting' || roundEndedRef.current} />
          <DodgeButton direction="right" onPress={performDodge} cdRemaining={dodgeRemaining} disabled={phase === 'resting' || roundEndedRef.current} />
        </div>
      </div>
    </>
  );
}
