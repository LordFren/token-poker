import { useState } from "react";
import { DEFAULT_MODEL_ID, modelList, PRICING, RoomMode } from "@token-poker/shared";
import { useApp } from "../store";

export function Landing({ prefillCode }: { prefillCode?: string }) {
  const { createRoom, joinByCode, state } = useApp();
  const models = modelList();

  const [hostName, setHostName] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [mode, setMode] = useState<RoomMode>("backlog");
  const [estimatePoints, setEstimatePoints] = useState(true);

  const [joinName, setJoinName] = useState("");
  const [code, setCode] = useState(prefillCode ?? "");

  const disabled = !state.connected;

  return (
    <div className="center">
      <div style={{ width: "100%", maxWidth: 720 }}>
        <div className="brand" style={{ marginBottom: 6, fontSize: 26 }}>
          <span className="dot" /> token-poker
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Planning poker, but you estimate features in <strong>LLM tokens</strong> — with a rough cost rollup.
        </p>

        <div className="grid cols-2" style={{ marginTop: 18 }}>
          {/* Create */}
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              if (hostName.trim()) void createRoom(hostName.trim(), modelId, mode, estimatePoints);
            }}
          >
            <h2>Start a room</h2>
            <label className="field">
              <span className="lbl">Your name</span>
              <input
                type="text"
                value={hostName}
                maxLength={40}
                placeholder="e.g. Ada"
                onChange={(e) => setHostName(e.target.value)}
                autoFocus={!prefillCode}
              />
            </label>
            <div className="field">
              <span className="lbl">Session style</span>
              <label className="row" style={{ gap: 8, alignItems: "baseline", cursor: "pointer" }}>
                <input type="radio" name="mode" checked={mode === "backlog"} onChange={() => setMode("backlog")} />
                <span>
                  <strong>Backlog</strong>{" "}
                  <span className="muted small">— type stories in, estimate one by one, export a summary.</span>
                </span>
              </label>
              <label className="row" style={{ gap: 8, alignItems: "baseline", cursor: "pointer", marginTop: 6 }}>
                <input type="radio" name="mode" checked={mode === "quick"} onChange={() => setMode("quick")} />
                <span>
                  <strong>Quick rounds</strong>{" "}
                  <span className="muted small">
                    — no story text. Discuss the issue on your call, vote, accept, next. Titles never leave your
                    tracker.
                  </span>
                </span>
              </label>
            </div>
            <div className="field">
              <label className="row" style={{ gap: 8, alignItems: "baseline", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={estimatePoints}
                  onChange={(e) => setEstimatePoints(e.target.checked)}
                />
                <span>
                  <strong>Also estimate story points</strong>{" "}
                  <span className="muted small">
                    — pick a points card and a token card side by side; results show your team's measured
                    tokens-per-point ratio.
                  </span>
                </span>
              </label>
            </div>
            <label className="field">
              <span className="lbl">Pricing model (for cost estimates)</span>
              <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — ${m.in}/${m.out} per 1M
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" type="submit" disabled={disabled || !hostName.trim()} style={{ width: "100%" }}>
              Create room
            </button>
          </form>

          {/* Join */}
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              if (joinName.trim() && code.trim()) void joinByCode(code.trim(), joinName.trim());
            }}
          >
            <h2>{prefillCode ? "Join this room" : "Join a room"}</h2>
            <label className="field">
              <span className="lbl">Room code</span>
              <input
                type="text"
                value={code}
                maxLength={24}
                placeholder="paste code or link"
                onChange={(e) => setCode(extractCode(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="lbl">Your name</span>
              <input
                type="text"
                value={joinName}
                maxLength={40}
                placeholder="e.g. Grace"
                onChange={(e) => setJoinName(e.target.value)}
                autoFocus={!!prefillCode}
              />
            </label>
            <button
              className="btn primary"
              type="submit"
              disabled={disabled || !joinName.trim() || !code.trim()}
              style={{ width: "100%" }}
            >
              Join room
            </button>
          </form>
        </div>

        <p className="muted small" style={{ marginTop: 16 }}>
          {disabled ? "Connecting…" : `Pricing: ${Object.values(PRICING).length} models · rooms expire automatically`}
        </p>
      </div>
    </div>
  );
}

/** Accept either a raw code or a full /r/<code> link pasted into the field. */
function extractCode(input: string): string {
  const m = /\/r\/([A-Za-z0-9]{4,24})/.exec(input);
  return (m ? m[1] : input).trim();
}
