import { useEffect, useState } from "react";
import { cardLabel, costFor, DECK, isNumericCard, modelList, PRICING, SP_DECK, StoryView } from "@token-poker/shared";
import { useApp } from "../store";
import { Deck } from "../components/Deck";
import { fmtExpiry, fmtTokens, fmtUsd } from "../lib/format";

export function Room() {
  const app = useApp();
  const snap = app.state.snapshot;

  if (!snap) {
    return (
      <div className="center">
        <div className="card" style={{ textAlign: "center" }}>
          <h2>Connecting…</h2>
          <p className="muted">Joining the room.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <Header />
      <div className="grid room-grid" style={{ marginTop: 18 }}>
        <main className="grid" style={{ alignContent: "start" }}>
          <CurrentStory />
          {snap.room.mode === "backlog" && snap.you.isHost && <AddStory />}
          {snap.room.mode === "backlog" && snap.backlog.length > 0 && <Backlog stories={snap.backlog} />}
          {snap.done.length > 0 && <Results />}
        </main>
        <aside className="grid" style={{ alignContent: "start" }}>
          <Players />
          {snap.you.isHost && <ModelSelector />}
        </aside>
      </div>
    </div>
  );
}

function useSnap() {
  const app = useApp();
  return { app, snap: app.state.snapshot! };
}

function Header() {
  const { app, snap } = useSnap();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/r/${snap.room.code}`;
  const perM = costFor(1_000_000, snap.room.modelId, snap.room.outputRatio);
  const modelLabel = PRICING[snap.room.modelId]?.label ?? snap.room.modelId;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      app.toast("Copy failed — select the link manually.");
    }
  };

  return (
    <header className="row wrap">
      <div className="brand" style={{ fontSize: 20 }}>
        <span className="dot" /> token-poker
      </div>
      <span className="pill" title="Room code">
        <span className="mono">{snap.room.code}</span>
      </span>
      {snap.room.mode === "quick" && (
        <span className="pill" title="Quick rounds: auto-numbered votes, no story text — issue titles stay in your tracker">
          ⚡ quick
        </span>
      )}
      <button className="btn sm" onClick={copy}>
        {copied ? "✓ Copied" : "Copy invite link"}
      </button>
      <div className="spacer" />
      <span
        className="pill"
        title={`Blended rate: ${Math.round(snap.room.outputRatio * 100)}% of each estimate priced as output tokens, the rest as input`}
      >
        <span className="swatch" /> {modelLabel} · <span className="mono">{fmtUsd(perM)}/1M</span>
      </span>
      <span className="pill" title="Room expiry">
        expires {fmtExpiry(snap.room.expiresAt)}
      </span>
      <span className="pill" title={app.state.connected ? "Connected" : "Reconnecting…"}>
        <span className={`statusdot${app.state.connected ? " online" : ""}`} />
        {app.state.connected ? "live" : "off"}
      </span>
      <button className="btn sm" onClick={app.goLanding} title="Leave this room on this device (clears your saved host/player token)">
        Leave
      </button>
    </header>
  );
}

function Players() {
  const { snap } = useSnap();
  const voting = snap.currentStory?.status === "voting";
  return (
    <section className="panel">
      <h3>Players</h3>
      <ul className="players">
        {snap.players.map((p) => (
          <li key={p.id}>
            <span className={`statusdot${p.online ? " online" : ""}`} />
            <span className="name">{p.name}</span>
            {p.id === snap.you.playerId && <span className="tag">you</span>}
            {p.isHost && <span className="tag">host</span>}
            {p.isSpectator && <span className="tag">spectator</span>}
            <span className="spacer" />
            {voting && !p.isSpectator && (
              <span className={p.hasVoted ? "check" : "waiting"}>{p.hasVoted ? "✓ voted" : "…"}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CurrentStory() {
  const { app, snap } = useSnap();
  const story = snap.currentStory;
  const quick = snap.room.mode === "quick";

  if (!story) {
    if (quick) {
      const nextN = snap.done.length + 1;
      return (
        <section className="card">
          <h2>{snap.done.length === 0 ? "Ready when you are" : "Vote accepted"}</h2>
          <p className="muted">
            Bring up the next issue in your own tracker or call — nothing needs to be typed in here.
          </p>
          {snap.you.isHost ? (
            <button className="btn primary" onClick={() => app.quickStart()}>
              Start vote #{nextN}
            </button>
          ) : (
            <p className="muted">Waiting for the host to start vote #{nextN}…</p>
          )}
        </section>
      );
    }
    return (
      <section className="card">
        <h2>No active story</h2>
        <p className="muted">
          {snap.you.isHost ? "Add a story below to start estimating." : "Waiting for the host to add a story…"}
        </p>
      </section>
    );
  }

  const voters = snap.players.filter((p) => !p.isSpectator);
  const votedCount = voters.filter((p) => p.hasVoted).length;

  return (
    <section className="card">
      <div className="row">
        <h2 style={{ marginBottom: 2 }}>{story.title}</h2>
        <div className="spacer" />
        <span className="pill">round {story.round}</span>
      </div>
      {story.description && <p className="muted" style={{ marginTop: 4 }}>{story.description}</p>}

      <div className="divider" />

      {story.status === "voting" ? (
        <>
          {snap.room.estimatePoints && (
            <>
              <div className="muted small" style={{ marginBottom: 8 }}>
                Story points — how big does it feel?
              </div>
              <Deck
                values={SP_DECK}
                kind="points"
                selected={snap.you.mySpVote}
                disabled={snap.you.isSpectator}
                onPick={(v) => app.vote(story.id, story.round, { spValue: v })}
              />
              <div className="muted small" style={{ margin: "14px 0 8px" }}>
                Tokens — what will it burn?
              </div>
            </>
          )}
          <Deck
            values={DECK}
            kind="tokens"
            selected={snap.you.myVote}
            disabled={snap.you.isSpectator}
            onPick={(v) => app.vote(story.id, story.round, { cardValue: v })}
          />
          <div className="row" style={{ marginTop: 16 }}>
            <span className="muted">
              <span className="num">{votedCount}</span> of <span className="num">{voters.length}</span> voted
            </span>
            <div className="spacer" />
            {snap.you.isHost && (
              <button className="btn primary" disabled={votedCount === 0} onClick={() => app.reveal(story.id)}>
                Reveal
              </button>
            )}
          </div>
        </>
      ) : (
        <RevealView story={story} />
      )}
    </section>
  );
}

function RevealView({ story }: { story: StoryView }) {
  const { app, snap } = useSnap();
  const quick = snap.room.mode === "quick";
  const withPoints = snap.room.estimatePoints;
  const stats = story.stats ?? null;
  const spStats = story.spStats ?? null;
  const votes = story.votes ?? [];
  const nameOf = (id: string) => snap.players.find((p) => p.id === id)?.name ?? "—";

  const [estimate, setEstimate] = useState<string>("");
  const [points, setPoints] = useState<string>("");
  useEffect(() => {
    setEstimate(String(stats?.suggested ?? stats?.median ?? 0));
    setPoints(String(spStats?.suggested ?? spStats?.median ?? 0));
    // re-init when a new reveal happens
  }, [story.id, story.round]); // eslint-disable-line react-hooks/exhaustive-deps

  const estTokens = Number(estimate) || 0;
  const estCost = costFor(estTokens, snap.room.modelId, snap.room.outputRatio);

  return (
    <>
      <div className="reveal">
        {votes.map((v) => {
          const numeric = v.cardValue != null && isNumericCard(v.cardValue);
          const outlier =
            numeric && stats && stats.spread! > 0 && (Number(v.cardValue) === stats.min || Number(v.cardValue) === stats.max);
          return (
            <div className={`seat${outlier ? " outlier" : ""}`} key={v.playerId}>
              <div className="v">{v.cardValue ? cardLabel(v.cardValue) : "—"}</div>
              {withPoints && (
                <div className="muted small">{v.spValue ? `${cardLabel(v.spValue)} pts` : "no pts"}</div>
              )}
              <div className="who">{nameOf(v.playerId)}</div>
            </div>
          );
        })}
      </div>

      {stats && stats.count > 0 && (
        <div className="stats">
          <div className="stat">
            <div className="k">median</div>
            <div className="val">{stats.median != null ? fmtTokens(stats.median) : "—"}</div>
          </div>
          <div className="stat">
            <div className="k">mean</div>
            <div className="val">{stats.mean != null ? fmtTokens(Math.round(stats.mean)) : "—"}</div>
          </div>
          <div className="stat">
            <div className="k">range</div>
            <div className="val">
              {stats.min != null ? fmtTokens(stats.min) : "—"}–{stats.max != null ? fmtTokens(stats.max) : "—"}
            </div>
          </div>
          <div className="stat">
            <div className="k">votes</div>
            <div className="val">{stats.count}</div>
          </div>
          {spStats && spStats.count > 0 && (
            <div className="stat" title="Median of the story-point votes">
              <div className="k">pts median</div>
              <div className="val">{spStats.median}</div>
            </div>
          )}
          <div className="stat" title="Median estimate at the room's pricing model and output share">
            <div className="k">≈ cost</div>
            <div className="val">
              {stats.median != null ? fmtUsd(costFor(stats.median, snap.room.modelId, snap.room.outputRatio)) : "—"}
            </div>
          </div>
        </div>
      )}

      {snap.you.isHost && (
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => app.reset(story.id)}>
            Re-vote
          </button>
          <div className="spacer" />
          {withPoints && (
            <label className="row" style={{ gap: 8 }}>
              <span className="muted small">final points</span>
              <input
                type="text"
                inputMode="numeric"
                className="mono"
                style={{ width: 64 }}
                value={points}
                onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
          )}
          <label className="row" style={{ gap: 8 }}>
            <span className="muted small">final tokens</span>
            <input
              type="text"
              inputMode="numeric"
              className="mono"
              style={{ width: 130 }}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <span className="muted small" title="At the room's pricing model and output share">
              = <span className="mono">{fmtTokens(estTokens)}</span> ≈ <span className="mono">{fmtUsd(estCost)}</span>
            </span>
          </label>
          <button
            className="btn primary"
            onClick={() =>
              app.nextStory(story.id, Number(estimate) || 0, quick, withPoints ? Number(points) || 0 : undefined)
            }
          >
            {quick ? "Accept → next vote" : "Accept → next"}
          </button>
        </div>
      )}
    </>
  );
}

function AddStory() {
  const { app } = useSnap();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        app.addStory(title.trim(), desc.trim() || undefined);
        setTitle("");
        setDesc("");
      }}
    >
      <h3>Add a story</h3>
      <label className="field">
        <span className="lbl">Title</span>
        <input type="text" maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. OAuth login flow" />
      </label>
      <label className="field">
        <span className="lbl">Description (optional)</span>
        <textarea maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="context, acceptance criteria…" />
      </label>
      <button className="btn" type="submit" disabled={!title.trim()}>
        Add to backlog
      </button>
    </form>
  );
}

function Backlog({ stories }: { stories: StoryView[] }) {
  return (
    <section className="panel">
      <h3>Backlog · {stories.length}</h3>
      <ul className="players">
        {stories.map((s) => (
          <li key={s.id}>
            <span className="name">{s.title}</span>
            <span className="spacer" />
            <span className="muted small">pending</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Results() {
  const { app, snap } = useSnap();
  const modelLabel = PRICING[snap.room.modelId]?.label ?? snap.room.modelId;
  const withPoints = snap.room.estimatePoints;
  const tokensPerPoint = withPoints && snap.totals.points > 0 ? Math.round(snap.totals.tokens / snap.totals.points) : null;

  const copySummary = async () => {
    const lines = withPoints
      ? [
          `# token-poker estimate (${modelLabel})`,
          "",
          "| Story | Pts | Tokens | Cost |",
          "|---|---:|---:|---:|",
          ...snap.done.map(
            (s) => `| ${s.title} | ${s.finalPoints ?? 0} | ${s.finalEstimate ?? 0} | ${fmtUsd(s.costUsd ?? 0)} |`,
          ),
          `| **Total** | **${snap.totals.points}** | **${snap.totals.tokens}** | **${fmtUsd(snap.totals.costUsd)}** |`,
          ...(tokensPerPoint != null ? ["", `Measured ratio: ≈ ${tokensPerPoint} tokens per story point.`] : []),
        ]
      : [
          `# token-poker estimate (${modelLabel})`,
          "",
          "| Story | Tokens | Cost |",
          "|---|---:|---:|",
          ...snap.done.map((s) => `| ${s.title} | ${s.finalEstimate ?? 0} | ${fmtUsd(s.costUsd ?? 0)} |`),
          `| **Total** | **${snap.totals.tokens}** | **${fmtUsd(snap.totals.costUsd)}** |`,
        ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      app.toast("Summary copied as markdown.");
    } catch {
      app.toast("Copy failed.");
    }
  };

  return (
    <section className="card">
      <div className="row">
        <h2>Results</h2>
        <div className="spacer" />
        <button className="btn sm" onClick={copySummary}>
          Copy summary
        </button>
      </div>
      <table className="results">
        <thead>
          <tr>
            <th>Story</th>
            {withPoints && <th className="num">Pts</th>}
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {snap.done.map((s) => (
            <tr key={s.id}>
              <td>{s.title}</td>
              {withPoints && <td className="num">{s.finalPoints ?? 0}</td>}
              <td className="num">{fmtTokens(s.finalEstimate ?? 0)}</td>
              <td className="num">{fmtUsd(s.costUsd ?? 0)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total · {modelLabel}</td>
            {withPoints && <td className="num">{snap.totals.points}</td>}
            <td className="num">{fmtTokens(snap.totals.tokens)}</td>
            <td className="num">{fmtUsd(snap.totals.costUsd)}</td>
          </tr>
        </tfoot>
      </table>
      {tokensPerPoint != null && (
        <p className="muted small" style={{ marginTop: 8 }} title="Accepted tokens ÷ accepted points — your team's empirical conversion rate">
          Measured ratio: ≈ <span className="mono">{fmtTokens(tokensPerPoint)}</span> tokens per story point.
        </p>
      )}
    </section>
  );
}

function ModelSelector() {
  const { app, snap } = useSnap();
  const models = modelList();
  const model = PRICING[snap.room.modelId];
  const pct = Math.round(snap.room.outputRatio * 100);
  const perM = costFor(1_000_000, snap.room.modelId, snap.room.outputRatio);
  const setRatio = (r: number) => app.setModel(snap.room.modelId, r);
  return (
    <section className="panel">
      <h3>Cost model</h3>
      <label className="field">
        <span className="lbl">Pricing model</span>
        <select value={snap.room.modelId} onChange={(e) => app.setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — ${m.in} in / ${m.out} out per 1M
            </option>
          ))}
        </select>
      </label>
      <label className="field" style={{ marginBottom: 0 }}>
        <span className="lbl">
          Output share: <span className="mono">{pct}%</span> → blended{" "}
          <span className="mono">{fmtUsd(perM)}/1M</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setRatio(Number(e.target.value) / 100)}
          style={{ width: "100%" }}
        />
      </label>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          className="btn sm"
          onClick={() => setRatio(0.1)}
          title="Agent sessions are input-heavy: context, file reads, and tool results dominate; the model's own output is ~10% of tokens."
        >
          {pct === 10 ? "✓ " : ""}Agentic session · 10%
        </button>
        <button
          className="btn sm"
          onClick={() => setRatio(0.5)}
          title="For one-shot API calls the response is a large slice of the total — closer to half."
        >
          {pct === 50 ? "✓ " : ""}Single API call · 50%
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>
        Output tokens cost ~5× more than input{model ? ` (${model.label}: $${model.in} in vs $${model.out} out per 1M)` : ""}.
        Estimates are a single token count, so this slider sets how much of each estimate is priced
        as output vs input. Estimating agent/Claude Code tasks? Use ~10% — most tokens are re-sent
        context and tool results. Estimating one-shot API calls? Use ~50%.
      </p>
    </section>
  );
}
