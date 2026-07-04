/** Themed placeholder panel used by the stub tab screens (Phase 1 only). */
export function StubPanel({ title, note }: { title: string; note: string }) {
  return (
    <div className="m-stub">
      <div className="m-stub-panel">
        <div className="m-stub-title">{title}</div>
        <div className="m-stub-note">{note}</div>
      </div>
    </div>
  );
}
