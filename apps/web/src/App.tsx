import { Suspense, lazy } from "react";
import { useSession } from "./state/session";
import { CharacterSelect } from "./ui/CharacterSelect";
import { Game } from "./ui/Game";
import { Login } from "./ui/Login";

// Dev-only tool; lazy so the game bundle doesn't pay for it.
const AssetLab = lazy(() => import("./dev/AssetLab").then((m) => ({ default: m.AssetLab })));

export function App() {
  const screen = useSession((s) => s.screen);
  switch (screen) {
    case "login":
      return <Login />;
    case "characters":
      return <CharacterSelect />;
    case "game":
      return <Game />;
    case "assetlab":
      return (
        <Suspense fallback={<div className="screen" />}>
          <AssetLab />
        </Suspense>
      );
  }
}
