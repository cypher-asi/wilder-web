// Watch tab: the mobile skin of the shared live-watch view. The tab is a
// transparent overlay — the game canvas (paused on every other tab) shows
// through behind it — driving the FollowCamera over one owned agent with
// follow/explore modes, pinch/button zoom, and a live action ticker. All of
// that logic lives in ../ui/watch; this file only supplies the mobile CSS
// skin and the empty-state hand-off to the Agents tab.

import { GameConnection } from "../net/connection";
import { useGame } from "../state/game";
import { useWatchController, WatchView } from "../ui/watch";

export function WatchTab({ connection }: { connection: GameConnection }) {
  const ctrl = useWatchController(connection);
  const setMobileTab = useGame((s) => s.setMobileTab);

  return (
    <WatchView
      ctrl={ctrl}
      variant="m"
      onEmptyCta={() => setMobileTab("agents")}
      emptyCtaLabel="GO TO AGENTS"
    />
  );
}
