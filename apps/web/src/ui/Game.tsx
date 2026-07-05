import { useEffect, useMemo, useState } from "react";
import {
  setMusicEnabled,
  startAmbience,
  startCrowd,
  stopAmbience,
  stopCrowd,
  stopMusic,
} from "../assets/audio";
import { CHARACTER_MODEL, PISTOL_MODEL, preloadModels } from "../assets/catalog";
import { MobileShell } from "../mobile/MobileShell";
import { useIsMobile } from "../mobile/useIsMobile";
import { GameConnection } from "../net/connection";
import { GameCanvas } from "../render/GameCanvas";
import { game, useGame } from "../state/game";
import { useSession } from "../state/session";
import { Hud } from "./Hud";

/** Never hold the veil longer than this, even if loading stalls. */
const VEIL_MAX_MS = 2000;

/**
 * Dark full-screen veil over the first world load: matches the page
 * background and fades out once the join completed and the first chunk batch
 * revealed, hiding the empty sky/ocean frame and the initial build burst.
 */
function JoinVeil() {
  const ready = useGame((s) => s.joined && s.worldReady);
  const [timedOut, setTimedOut] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), VEIL_MAX_MS);
    return () => clearTimeout(timer);
  }, []);

  if (gone) return null;
  const hidden = ready || timedOut;
  return (
    <div
      className={`join-veil${hidden ? " join-veil-out" : ""}`}
      onTransitionEnd={() => setGone(true)}
    />
  );
}

export function Game() {
  const token = useSession((s) => s.token);
  const character = useSession((s) => s.activeCharacter);
  const mobile = useIsMobile();

  // `mobile` is a dep on purpose: the join mode (spectator vs avatar) is fixed
  // at JoinWorld time, so crossing the mobile threshold rebuilds the
  // connection and rejoins in the right mode.
  const connection = useMemo(() => {
    if (!token || !character) return null;
    return new GameConnection(token, character.id);
  }, [token, character, mobile]);

  useEffect(() => {
    // Usually already warm from CharacterSelect; the cache dedupes.
    preloadModels([CHARACTER_MODEL, PISTOL_MODEL]);
  }, []);

  useEffect(() => {
    if (!connection) return;
    connection.connect();
    startAmbience();
    startCrowd();
    // Honour the saved music preference for this session (join was a user
    // gesture, so autoplay is unblocked here).
    setMusicEnabled(useGame.getState().musicOn);
    return () => {
      connection.close();
      game.reset();
      stopAmbience();
      stopCrowd();
      stopMusic();
    };
  }, [connection]);

  // Right-click is a gameplay input (move / camera); suppress the browser
  // context menu everywhere in-game, not just on the WebGL canvas.
  useEffect(() => {
    const suppress = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  if (!connection) return null;

  return (
    <>
      <GameCanvas connection={connection} />
      {mobile ? (
        <MobileShell connection={connection} />
      ) : (
        <Hud connection={connection} />
      )}
      <JoinVeil />
    </>
  );
}
