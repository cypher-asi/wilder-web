// Reusable mobile bottom sheet: slides up from the bottom edge, dismisses on
// backdrop tap or a downward drag past a threshold, rounds its top corners,
// pads for the home-indicator safe area and scrolls internally up to ~85dvh.
// No dependencies — plain pointer events.

import { ReactNode, useEffect, useRef, useState } from "react";

const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 0.55; // px/ms

export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const drag = useRef<{ startY: number; lastY: number; lastT: number; velocity: number } | null>(
    null,
  );

  // Reset any in-flight drag whenever the sheet re-opens.
  useEffect(() => {
    if (open) {
      setDragY(0);
      drag.current = null;
    }
  }, [open]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.velocity = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    setDragY(Math.max(0, e.clientY - d.startY));
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && (d.lastY - d.startY > DISMISS_DISTANCE || d.velocity > DISMISS_VELOCITY)) {
      onClose();
    }
    setDragY(0);
  };

  return (
    <div className="m-sheet-backdrop" onClick={onClose}>
      <div
        className="m-sheet"
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="m-sheet-grab"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="m-sheet-handle" />
          {title && <div className="m-sheet-title">{title}</div>}
        </div>
        <div className="m-sheet-body m-scroll">{children}</div>
      </div>
    </div>
  );
}
