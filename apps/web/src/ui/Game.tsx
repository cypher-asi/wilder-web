import { useEffect, useMemo } from "react";
import { startAmbience, stopAmbience } from "../assets/audio";
import { GameConnection } from "../net/connection";
import { GameCanvas } from "../render/GameCanvas";
import { game } from "../state/game";
import { useSession } from "../state/session";
import { Hud } from "./Hud";

export function Game() {
  const token = useSession((s) => s.token);
  const character = useSession((s) => s.activeCharacter);

  const connection = useMemo(() => {
    if (!token || !character) return null;
    return new GameConnection(token, character.id);
  }, [token, character]);

  useEffect(() => {
    if (!connection) return;
    connection.connect();
    startAmbience();
    return () => {
      connection.close();
      game.reset();
      stopAmbience();
    };
  }, [connection]);

  if (!connection) return null;

  return (
    <>
      <GameCanvas connection={connection} />
      <Hud connection={connection} />
    </>
  );
}
