// Audio: file-based SFX via Howler + a synthesized rain/city ambience bed
// (filtered noise through Web Audio, so no large looping asset is needed).

import { Howl, Howler } from "howler";
import { getAudioUrl } from "./catalog";

const sfxCache = new Map<string, Howl | null>();

async function getSfx(id: string): Promise<Howl | null> {
  if (sfxCache.has(id)) return sfxCache.get(id) ?? null;
  const url = await getAudioUrl(id);
  const howl = url ? new Howl({ src: [url], volume: 0.5 }) : null;
  sfxCache.set(id, howl);
  return howl;
}

export async function playSfx(id: string, volume = 0.5) {
  const sfx = await getSfx(id);
  if (sfx) {
    sfx.volume(volume);
    sfx.play();
  }
}

const GRUNT_IDS = ["sfx_grunt1", "sfx_grunt2", "sfx_grunt3"];

/** Pain grunt for a shot NPC: random variant + slight pitch wobble so rapid
 * fire doesn't sound like a stuck sample. */
export async function playGrunt(volume = 0.5) {
  const id = GRUNT_IDS[Math.floor(Math.random() * GRUNT_IDS.length)];
  const sfx = await getSfx(id);
  if (sfx) {
    sfx.volume(volume);
    sfx.rate(0.92 + Math.random() * 0.16);
    sfx.play();
  }
}

// --- Synthesized UI blips (coin / deny) ------------------------------------
// Tiny square-wave cues built on Web Audio so no asset files are needed and
// the coin can be a proper two-note NES-style chime.

let blipCtx: AudioContext | null = null;

function getBlipCtx(): AudioContext | null {
  try {
    blipCtx ??= new AudioContext();
    if (blipCtx.state !== "running") void blipCtx.resume();
    return blipCtx;
  } catch {
    return null;
  }
}

/**
 * Classic coin chime for pickups: square wave hopping B5 -> E6, with a fast
 * exponential decay. Deliberately reads as Super Mario Bros. nostalgia.
 */
export function playCoin(volume = 0.22) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(987.77, t0); // B5
  osc.frequency.setValueAtTime(1318.51, t0 + 0.085); // E6
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.setValueAtTime(volume, t0 + 0.085);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.6);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Rising major-arpeggio fanfare for a level-up: the marquee dopamine cue.
 * Square-wave triad walking up C5-E5-G5-C6 with a bright ring-out on top,
 * deliberately reading as classic power-up / stage-clear nostalgia.
 */
export function playLevelUp(volume = 0.2) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  // C5, E5, G5, C6, E6 — a quick ascending run then a held top note.
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
  const step = 0.09;
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, t0 + i * step);
    const gain = ctx.createGain();
    const start = t0 + i * step;
    const last = i === notes.length - 1;
    const dur = last ? 0.5 : step + 0.04;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0008, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  });
}

/** Quick ascending sweep for a kill-confirm / power moment. */
export function playPowerUp(volume = 0.16) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(392, t0); // G4
  osc.frequency.exponentialRampToValueAtTime(1174.66, t0 + 0.16); // D6
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.26);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/** Short two-note "ka-ching" confirm for a completed purchase. */
export function playPurchase(volume = 0.18) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(1046.5, t0); // C6
  osc.frequency.setValueAtTime(1567.98, t0 + 0.07); // G6
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.setValueAtTime(volume, t0 + 0.07);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.32);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

let noiseBuffer: AudioBuffer | null = null;

/** Shared short white-noise buffer for percussive/mechanical cues. */
function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 0.25);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

/**
 * Mechanical "cha-chik" for picking up ammo: two clacks, each a wide-band
 * noise burst (metallic snap of a magazine/charging handle) reinforced by a
 * short tonal click for body, so ammo reads distinctly - and at a comparable
 * loudness to - the coin/loot chime. Filtered noise is perceptually weak, so
 * this runs hot and leans on the tonal clicks to carry. Synthesized.
 */
export function playAmmo(volume = 0.6) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  // Two clacks: a heavier "cha" then a snappier "chik".
  const clacks = [
    { at: 0, noiseFreq: 1000, q: 0.9, dur: 0.075, clickFreq: 180 },
    { at: 0.1, noiseFreq: 2000, q: 1.2, dur: 0.06, clickFreq: 300 },
  ];
  for (const c of clacks) {
    const start = t0 + c.at;
    // Wide-band noise burst (metallic snap), boosted hard.
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = c.noiseFreq;
    filter.Q.value = c.q;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, start);
    nGain.gain.linearRampToValueAtTime(volume, start + 0.003);
    nGain.gain.exponentialRampToValueAtTime(0.001, start + c.dur);
    src.connect(filter).connect(nGain).connect(ctx.destination);
    src.start(start);
    src.stop(start + c.dur + 0.02);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      nGain.disconnect();
    };
    // Short tonal click gives the clack presence/loudness.
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(c.clickFreq, start);
    osc.frequency.exponentialRampToValueAtTime(c.clickFreq * 0.6, start + 0.03);
    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(0.0001, start);
    oGain.gain.linearRampToValueAtTime(volume * 0.7, start + 0.003);
    oGain.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
    osc.connect(oGain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.07);
    osc.onended = () => {
      osc.disconnect();
      oGain.disconnect();
    };
  }
}

/**
 * Soft muffled "thunk" for grabbing a physical item (resources, materials,
 * gear). A short triangle pluck dropping in pitch — distinct from the coin
 * chime (currency) and the cartridge clack (ammo).
 */
export function playPickup(volume = 0.2) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(440, t0); // A4
  osc.frequency.exponentialRampToValueAtTime(294, t0 + 0.12); // ~D4
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.24);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Sci-fi pneumatic door whoosh. A band-passed noise hiss (the pressurized
 * air) swept together with a tonal sweep for a Tron-ish hydraulic slide —
 * pitch/filter sweep UP for opening, DOWN for closing. Fully synthesized.
 */
export function playDoor(open: boolean, volume = 0.3) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const dur = 0.42;

  // Air hiss: white noise through a resonant bandpass whose centre sweeps.
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  const [f0, f1] = open ? [420, 2600] : [2600, 420];
  bp.frequency.setValueAtTime(f0, t0);
  bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(0.0001, t0);
  nGain.gain.linearRampToValueAtTime(volume, t0 + 0.05);
  nGain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  src.connect(bp).connect(nGain).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
  src.onended = () => {
    src.disconnect();
    bp.disconnect();
    nGain.disconnect();
  };

  // Tonal body: sawtooth sweep that reinforces the direction of travel.
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  const [p0, p1] = open ? [180, 620] : [620, 180];
  osc.frequency.setValueAtTime(p0, t0);
  osc.frequency.exponentialRampToValueAtTime(p1, t0 + dur);
  const oGain = ctx.createGain();
  oGain.gain.setValueAtTime(0.0001, t0);
  oGain.gain.linearRampToValueAtTime(volume * 0.4, t0 + 0.04);
  oGain.gain.exponentialRampToValueAtTime(0.0006, t0 + dur);
  osc.connect(oGain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
  osc.onended = () => {
    osc.disconnect();
    oGain.disconnect();
  };
}

/** Low double-buzz for refused actions (backpack full). */
export function playDeny(volume = 0.18) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(150, t0);
  osc.frequency.setValueAtTime(110, t0 + 0.11);
  const gain = ctx.createGain();
  // Two pulses with a short gap between them.
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.setValueAtTime(0.0001, t0 + 0.08);
  gain.gain.setValueAtTime(volume, t0 + 0.11);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.26);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.3);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

/**
 * Corrupted-signal glitch burst for the death screen: a cluster of randomly
 * timed band-passed noise stabs ("static tearing") layered with a couple of
 * detuned square/saw blips whose pitch jumps in hard steps (no ramps) for a
 * bit-crushed, malfunctioning feel. Fully synthesized — no asset needed.
 */
export function playGlitch(volume = 0.4) {
  const ctx = getBlipCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;

  // 5 noise stabs at random offsets: each a short band/high-pass burst whose
  // centre frequency leaps around, reading as digital signal tearing.
  const stabs = 5;
  for (let i = 0; i < stabs; i++) {
    const start = t0 + Math.random() * 0.42;
    const dur = 0.02 + Math.random() * 0.06;
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = Math.random() < 0.5 ? "bandpass" : "highpass";
    filter.frequency.value = 600 + Math.random() * 5000;
    filter.Q.value = 0.6 + Math.random() * 4;
    const gain = ctx.createGain();
    // Hard on/off gate (no smooth attack) for a torn, clipped edge.
    gain.gain.setValueAtTime(volume * (0.5 + Math.random() * 0.5), start);
    gain.gain.setValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(start);
    src.stop(start + dur + 0.01);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  // 3 detuned tonal blips with stepped random pitch jumps — corrupted beeps.
  const blips = 3;
  for (let i = 0; i < blips; i++) {
    const start = t0 + Math.random() * 0.4;
    const osc = ctx.createOscillator();
    osc.type = Math.random() < 0.5 ? "square" : "sawtooth";
    // Two or three stepped frequencies within the blip's life.
    const steps = 2 + Math.floor(Math.random() * 2);
    const stepDur = 0.03 + Math.random() * 0.03;
    for (let s = 0; s < steps; s++) {
      osc.frequency.setValueAtTime(80 + Math.random() * 1120, start + s * stepDur);
    }
    const life = steps * stepDur;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume * 0.35, start);
    gain.gain.setValueAtTime(0.0001, start + life);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + life + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
}

// --- Main music -----------------------------------------------------------

let music: Howl | null = null;
// Gate so a toggle taken before the (async) load, or before the first user
// gesture, is honoured once the Howl exists / audio is unblocked.
let musicEnabled = false;

// Target playback level for the music bed. It shares the mix with the rain
// ambience below, so it has to sit clearly above that noise floor to be
// audible — a subtle dark-ambient track gets masked otherwise.
const MUSIC_VOLUME = 1.0;
const MUSIC_FADE_MS = 900;

async function ensureMusic(): Promise<Howl | null> {
  if (music) return music;
  const url = await getAudioUrl("music_theme");
  if (!url) return null;
  music = new Howl({ src: [url], loop: true, volume: 0 });
  return music;
}

/** Start (or resume) the looping main-music bed, if it is enabled. */
async function startMusic() {
  const howl = await ensureMusic();
  if (!howl || !musicEnabled) return;
  // Howler's shared AudioContext is created lazily on the first Howl and, when
  // that happens outside a direct user gesture, starts suspended — so play()
  // would be silent. Resume it (works under the sticky activation from the
  // join click / the toggle click) before/after starting playback.
  const ctx = Howler.ctx as AudioContext | undefined;
  if (ctx && ctx.state !== "running") void ctx.resume();
  const fadeUp = () => howl.fade(howl.volume(), MUSIC_VOLUME, MUSIC_FADE_MS);
  if (!howl.playing()) {
    howl.volume(0);
    howl.play();
    fadeUp();
    howl.once("unlock", () => {
      if (musicEnabled && !howl.playing()) {
        howl.volume(0);
        howl.play();
        fadeUp();
      }
    });
  } else {
    // Already looping (e.g. re-enabled mid fade-out): bring it back up.
    fadeUp();
  }
}

/** Stop the main-music bed without forgetting the enabled preference. */
export function stopMusic() {
  const howl = music;
  if (!howl || !howl.playing()) return;
  howl.fade(howl.volume(), 0, MUSIC_FADE_MS);
  howl.once("fade", () => {
    if (!musicEnabled) howl.stop();
  });
}

/** Live on/off from the settings toggle; starts/stops immediately. */
export function setMusicEnabled(on: boolean) {
  musicEnabled = on;
  if (on) void startMusic();
  else stopMusic();
}

// --- Footsteps loop -------------------------------------------------------

let footsteps: Howl | null = null;
let footstepsPlaying = false;

export async function setFootsteps(active: boolean, running: boolean) {
  if (!footsteps) {
    const url = await getAudioUrl("sfx_footsteps");
    if (!url) return;
    footsteps = new Howl({ src: [url], loop: true, volume: 0.35 });
  }
  footsteps.rate(running ? 1.35 : 1.0);
  if (active && !footstepsPlaying) {
    footsteps.play();
    footstepsPlaying = true;
  } else if (!active && footstepsPlaying) {
    footsteps.stop();
    footstepsPlaying = false;
  }
}

// --- Ambience (synthesized rain) ------------------------------------------

let ambience: { ctx: AudioContext; gain: GainNode } | null = null;

export function startAmbience() {
  if (ambience) return;
  try {
    const ctx = new AudioContext();
    // 4s of pink-ish noise, looped: reads as steady rain on concrete.
    const seconds = 4;
    const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.08;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 2600;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;

    src.connect(lowpass).connect(gain).connect(ctx.destination);
    src.start();
    // Fade in gently. Kept low so it reads as a background rain bed and does
    // not mask the main music, which shares the same mix.
    gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 3);
    ambience = { ctx, gain };
  } catch {
    // Audio not available (autoplay policy); retried on next user gesture.
  }
}

export function stopAmbience() {
  if (!ambience) return;
  const { ctx, gain } = ambience;
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
  setTimeout(() => ctx.close(), 600);
  ambience = null;
}

// --- Crowd chatter (synthesized talking bed) -------------------------------
// A density-driven ambience: a pool of "babbler" voices (formant-filtered
// noise whose gain is modulated by a slow LFO to fake syllable cadence) plus a
// steadier "murmur fill" that blends the voices into a wash. One or two nearby
// agents read as sparse individual talking; a big group swells into a crowd.

interface CrowdVoice {
  gain: GainNode; // per-voice level (lit as the crowd grows)
  baseGain: number; // its target level when fully lit
}

interface Crowd {
  ctx: AudioContext;
  master: GainNode;
  voices: CrowdVoice[];
  fill: GainNode;
}

let crowd: Crowd | null = null;

/** Agent count at which the crowd bed reaches its full large-crowd wash. */
const CROWD_FULL = 12;
/** Peak master level; kept near the rain bed so it sits under the music. */
const CROWD_PEAK = 0.2;
const CROWD_RAMP = 0.4;

/** Long looping noise buffer for the crowd bed (independent of the short
 * percussive noiseBuffer so its loop point is not audibly periodic). */
function makeCrowdNoise(ctx: AudioContext): AudioBuffer {
  const seconds = 3;
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Build (once) and start the crowd graph, silent until setCrowdLevel runs. */
export function startCrowd() {
  if (crowd) return;
  try {
    const ctx = new AudioContext();
    const noise = makeCrowdNoise(ctx);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // Babbler voices: each a noise -> bandpass (vocal formant) -> gain the LFO
    // opens and closes, so a lone voice sounds like intermittent talking.
    const voices: CrowdVoice[] = [];
    const VOICE_COUNT = 6;
    for (let i = 0; i < VOICE_COUNT; i++) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = 0.85 + Math.random() * 0.4;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 350 + Math.random() * 2000; // vocal formant range
      bp.Q.value = 3 + Math.random() * 3;

      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0;

      // Syllable LFO: pushes the voice gain up and down at a talking cadence.
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 2 + Math.random() * 3; // ~2-5 Hz syllables
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.5;
      lfo.connect(lfoDepth).connect(voiceGain.gain);

      src.connect(bp).connect(voiceGain).connect(master);
      src.start();
      lfo.start();

      voices.push({ gain: voiceGain, baseGain: 0.7 + Math.random() * 0.3 });
    }

    // Murmur fill: steady band-limited noise that fills the gaps between voices
    // so a large group blends into a continuous crowd hum instead of clatter.
    const fillSrc = ctx.createBufferSource();
    fillSrc.buffer = noise;
    fillSrc.loop = true;
    const fillBp = ctx.createBiquadFilter();
    fillBp.type = "bandpass";
    fillBp.frequency.value = 900;
    fillBp.Q.value = 0.8;
    const fill = ctx.createGain();
    fill.gain.value = 0;
    fillSrc.connect(fillBp).connect(fill).connect(master);
    fillSrc.start();

    crowd = { ctx, master, voices, fill };
  } catch {
    // Audio not available yet (autoplay policy); retried on the next start.
  }
}

/**
 * Steer the crowd bed toward `count` nearby agents. 0 fades to silence; 1-2
 * lights a couple of gappy voices; approaching CROWD_FULL brings every voice in
 * and fades up the murmur fill for a dense large-crowd wash.
 */
export function setCrowdLevel(count: number) {
  if (!crowd) return;
  const { ctx, master, voices, fill } = crowd;
  const t = ctx.currentTime;
  const level = Math.max(0, Math.min(1, count / CROWD_FULL));

  master.gain.linearRampToValueAtTime(CROWD_PEAK * level, t + CROWD_RAMP);

  // Light one voice per nearby agent (capped at the pool size): 1-2 agents
  // leaves most voices silent, so it reads as a few people talking.
  voices.forEach((v, i) => {
    const on = i < count;
    v.gain.gain.linearRampToValueAtTime(on ? v.baseGain : 0, t + CROWD_RAMP);
  });

  // Fill only comes up once it is genuinely a crowd, and stays subordinate.
  const fillLevel = Math.max(0, Math.min(1, (count - 2) / (CROWD_FULL - 2)));
  fill.gain.linearRampToValueAtTime(0.35 * fillLevel, t + CROWD_RAMP);
}

/** Fade out and tear down the crowd bed. */
export function stopCrowd() {
  if (!crowd) return;
  const { ctx, master } = crowd;
  master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
  setTimeout(() => ctx.close(), 600);
  crowd = null;
}
