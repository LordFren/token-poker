import { useApp } from "../store";

export function Expired() {
  const { goLanding } = useApp();
  return (
    <div className="center">
      <div className="card" style={{ maxWidth: 420, textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⌛</div>
        <h2>This room has expired</h2>
        <p className="muted">Rooms are temporary and clean themselves up after a while. Start a fresh one to keep estimating.</p>
        <button className="btn primary" onClick={goLanding} style={{ marginTop: 8 }}>
          Create a new room
        </button>
      </div>
    </div>
  );
}
