import { Suspense, lazy, useEffect } from "react";
import { useSession } from "./state/session";
import { CharacterSelect } from "./ui/CharacterSelect";
import { Game } from "./ui/Game";
import { Login } from "./ui/Login";

// Dev-only tool; lazy so the game bundle doesn't pay for it.
const AssetLab = lazy(() => import("./dev/AssetLab").then((m) => ({ default: m.AssetLab })));

// Guard against React StrictMode's double-invoked mount effect so we don't
// register two guests on the first load.
let hasBooted = false;

export function App() {
  const screen = useSession((s) => s.screen);
  const bootstrap = useSession((s) => s.bootstrap);

  useEffect(() => {
    if (hasBooted) return;
    hasBooted = true;
    void bootstrap();
  }, [bootstrap]);

  switch (screen) {
    case "boot":
      // Plain black through boot; the game then fades in from the same black
      // via <JoinVeil /> once the world is ready. No loading/branding flash.
      return <div style={{ position: "fixed", inset: 0, background: "#05060a" }} />;
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
