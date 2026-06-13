// Abuse / security smoke test. Start the server first (on :3000), e.g.:
//   PORT=3000 npm run start:local   (in another terminal)
// then:  npm run test:security
//
// Checks: (a) zod rejects malformed/oversized payloads, (b) host-only actions
// require the correct hostToken, (c) pre-reveal snapshots never leak card values,
// (d) event flooding is rate-limited.

import { io } from "socket.io-client";

const URL = process.env.URL ?? "http://localhost:3000";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function connect() {
  return new Promise((res, rej) => {
    const s = io(URL, { transports: ["websocket"], reconnection: false });
    s.once("connect", () => res(s));
    s.once("connect_error", rej);
    setTimeout(() => rej(new Error("connect timeout")), 4000);
  });
}

const ack = (s, ev, payload) =>
  new Promise((res) => {
    let done = false;
    s.emit(ev, payload, (r) => {
      done = true;
      res(r);
    });
    setTimeout(() => !done && res({ ok: false, error: "timeout" }), 3000);
  });

async function main() {
  const host = await connect();
  const lastSnap = { host: null, player: null };
  host.on("state", (s) => (lastSnap.host = s));

  // create room
  const created = await ack(host, "room:create", { name: "Host" });
  if (!created.ok) {
    ok("create room", false, created.error);
    process.exit(1);
  }
  ok("create room", true);
  const { code, hostToken } = created;

  // (a) malformed payloads rejected
  const badCreate = await ack(host, "room:create", { name: "x".repeat(500) });
  ok("(a) oversized name rejected", badCreate.ok === false, badCreate.error);

  // (b) host-only with wrong token rejected, correct token accepted
  const wrong = await ack(host, "addStory", { hostToken: "0".repeat(32), title: "hack" });
  ok("(b) addStory wrong hostToken rejected", wrong.ok === false, wrong.error);
  const good = await ack(host, "addStory", { hostToken, title: "OAuth login" });
  ok("(b) addStory correct hostToken accepted", good.ok === true, good.error);

  // player joins + votes
  const player = await connect();
  player.on("state", (s) => (lastSnap.player = s));
  const joined = await ack(player, "room:join", { code, name: "P2" });
  ok("player join", joined.ok === true, joined.error);
  const storyId = joined.ok ? joined.snapshot.currentStory?.id : null;

  // (a) bad card value rejected
  const badVote = await ack(player, "vote", { storyId, round: 1, cardValue: "evil" });
  ok("(a) invalid cardValue rejected", badVote.ok === false, badVote.error);

  // valid vote
  const vote = await ack(player, "vote", { storyId, round: 1, cardValue: "50000" });
  ok("valid vote accepted", vote.ok === true, vote.error);

  await delay(150);

  // (c) pre-reveal snapshot leaks no card values
  const snap = lastSnap.player ?? joined.snapshot;
  const leaked = snap?.currentStory?.votes !== undefined;
  const sawVotedFlag = snap?.players?.some((p) => p.hasVoted);
  ok("(c) pre-reveal hides card values", !leaked, leaked ? "votes array present!" : "");
  ok("(c) pre-reveal shows hasVoted flag", !!sawVotedFlag);

  // reveal, then card values should appear
  await ack(host, "reveal", { hostToken, storyId });
  await delay(150);
  const revealed = lastSnap.host?.currentStory;
  ok("reveal exposes card values", Array.isArray(revealed?.votes) && revealed.votes.length > 0);

  // (d) flooding is rate-limited
  let denied = 0;
  await Promise.all(
    Array.from({ length: 60 }, () =>
      ack(player, "vote", { storyId, round: 1, cardValue: "25000" }).then((r) => {
        if (!r.ok && /slow down/i.test(r.error ?? "")) denied++;
      }),
    ),
  );
  ok("(d) event flood rate-limited", denied > 0, `${denied}/60 denied`);

  host.close();
  player.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error("security-check error:", e.message);
  process.exit(1);
});
