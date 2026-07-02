import { useSession } from "./state/session";
import { CharacterSelect } from "./ui/CharacterSelect";
import { Game } from "./ui/Game";
import { Login } from "./ui/Login";

export function App() {
  const screen = useSession((s) => s.screen);
  switch (screen) {
    case "login":
      return <Login />;
    case "characters":
      return <CharacterSelect />;
    case "game":
      return <Game />;
  }
}
