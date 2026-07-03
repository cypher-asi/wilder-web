// Audio: file-based SFX via Howler + a synthesized rain/city ambience bed
// (filtered noise through Web Audio, so no large looping asset is needed).

import { Howl } from "howler";
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

// --- Main music -----------------------------------------------------------

let music: Howl | null = null;
// Gate so a toggle taken before the (async) load, or before the first user
// gesture, is honoured once the Howl exists / audio is unblocked.
let musicEnabled = false;

async function ensureMusic(): Promise<Howl | null> {
  if (music) return music;
  const url = await getAudioUrl("music_theme");
  if (!url) return null;
  music = new Howl({ src: [url], loop: true, volume: 0.3 });
  return music;
}

/** Start (or resume) the looping main-music bed, if it is enabled. */
async function startMusic() {
  const howl = await ensureMusic();
  if (howl && musicEnabled && !howl.playing()) howl.play();
}

/** Stop the main-music bed without forgetting the enabled preference. */
export function stopMusic() {
  music?.stop();
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
    // Fade in gently.
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 3);
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
