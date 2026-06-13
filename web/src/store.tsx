import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { Ack, CardValue, RoomMode, Snapshot, SpValue } from "@token-poker/shared";
import { socket } from "./socket";
import { clearIdentity, Identity, loadIdentity, saveIdentity } from "./lib/storage";

type RouteName = "landing" | "join" | "room" | "expired";
interface Route {
  name: RouteName;
  code?: string;
}

interface State {
  connected: boolean;
  route: Route;
  snapshot: Snapshot | null;
  identity: Identity | null;
  toast: string | null;
}

type Action =
  | { t: "connected"; v: boolean }
  | { t: "route"; v: Route }
  | { t: "snapshot"; v: Snapshot | null }
  | { t: "identity"; v: Identity | null }
  | { t: "toast"; v: string | null };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "connected":
      return { ...s, connected: a.v };
    case "route":
      return { ...s, route: a.v };
    case "snapshot":
      return { ...s, snapshot: a.v };
    case "identity":
      return { ...s, identity: a.v };
    case "toast":
      return { ...s, toast: a.v };
  }
}

interface Api {
  state: State;
  createRoom: (name: string, modelId?: string, mode?: RoomMode, estimatePoints?: boolean, spectator?: boolean) => Promise<void>;
  joinByCode: (code: string, name: string, spectator?: boolean) => Promise<void>;
  vote: (storyId: string, round: number, pick: { cardValue?: CardValue; spValue?: SpValue }) => void;
  addStory: (title: string, description?: string) => void;
  reveal: (storyId: string) => void;
  reset: (storyId: string) => void;
  nextStory: (storyId: string, finalEstimate?: number, startNext?: boolean, finalPoints?: number) => void;
  quickStart: () => void;
  setModel: (modelId: string, outputRatio?: number) => void;
  goLanding: () => void;
  toast: (msg: string) => void;
}

const Ctx = createContext<Api | null>(null);

function pathCode(): string | null {
  const m = /^\/r\/([A-Za-z0-9]{4,24})$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

function navigate(code: string): void {
  if (window.location.pathname !== `/r/${code}`) {
    window.history.pushState({}, "", `/r/${code}`);
  }
}

async function call<R>(event: string, payload: unknown): Promise<R> {
  // socket.io-client emitWithAck returns the server's ack arg.
  return (socket as unknown as { emitWithAck: (e: string, p: unknown) => Promise<R> }).emitWithAck(event, payload);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    connected: socket.connected,
    route: { name: "landing" },
    snapshot: null,
    identity: null,
    toast: null,
  });

  const identityRef = useRef<Identity | null>(null);
  identityRef.current = state.identity;

  const toast = (msg: string) => {
    dispatch({ t: "toast", v: msg });
    window.setTimeout(() => dispatch({ t: "toast", v: null }), 3200);
  };

  // ---- socket lifecycle + initial routing ----
  useEffect(() => {
    const onConnect = async () => {
      dispatch({ t: "connected", v: true });
      // Re-join automatically on (re)connect if we already have an identity.
      const id = identityRef.current;
      if (id) {
        const ack = await call<Ack>("room:join", { code: id.code, playerToken: id.playerToken });
        if (ack.ok) {
          dispatch({ t: "snapshot", v: ack.snapshot });
          dispatch({ t: "route", v: { name: "room", code: id.code } });
        } else {
          clearIdentity(id.code);
          dispatch({ t: "identity", v: null });
          dispatch({ t: "route", v: { name: "expired", code: id.code } });
        }
      }
    };
    const onDisconnect = () => dispatch({ t: "connected", v: false });
    const onState = (snap: Snapshot) => {
      dispatch({ t: "snapshot", v: snap });
      dispatch({ t: "route", v: { name: "room", code: snap.room.code } });
    };
    const onError = (msg: string) => toast(msg);
    const onExpired = () => {
      const id = identityRef.current;
      if (id) clearIdentity(id.code);
      dispatch({ t: "snapshot", v: null });
      dispatch({ t: "route", v: { name: "expired", code: id?.code } });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("state", onState);
    socket.on("error", onError);
    socket.on("expired", onExpired);

    // Initial route resolution from the URL.
    const code = pathCode();
    if (code) {
      const stored = loadIdentity(code);
      if (stored) {
        dispatch({ t: "identity", v: stored });
        dispatch({ t: "route", v: { name: "room", code } }); // onConnect will rejoin + fill snapshot
      } else {
        dispatch({ t: "route", v: { name: "join", code } });
        // Confirm the room still exists; otherwise show the expired screen.
        fetch(`/api/room/${code}`)
          .then((r) => r.json())
          .then((j: { exists: boolean }) => {
            if (!j.exists) dispatch({ t: "route", v: { name: "expired", code } });
          })
          .catch(() => void 0);
      }
    }

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("state", onState);
      socket.off("error", onError);
      socket.off("expired", onExpired);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requireHost = (): string | null => {
    const ht = identityRef.current?.hostToken;
    if (!ht) {
      toast("Only the host can do that.");
      return null;
    }
    return ht;
  };

  const simple = async (event: string, payload: unknown) => {
    const ack = await call<{ ok: boolean; error?: string }>(event, payload);
    if (!ack.ok && ack.error) toast(ack.error);
  };

  const api: Api = useMemo(
    () => ({
      state,
      async createRoom(name, modelId, mode, estimatePoints, spectator) {
        const ack = await call<Ack>("room:create", { name, modelId, mode, estimatePoints, spectator });
        if (!ack.ok) return toast(ack.error);
        const id: Identity = { code: ack.code, playerToken: ack.playerToken, hostToken: ack.hostToken };
        saveIdentity(id);
        dispatch({ t: "identity", v: id });
        dispatch({ t: "snapshot", v: ack.snapshot });
        dispatch({ t: "route", v: { name: "room", code: ack.code } });
        navigate(ack.code);
      },
      async joinByCode(code, name, spectator) {
        const stored = loadIdentity(code);
        const ack = await call<Ack>("room:join", {
          code,
          name,
          spectator,
          playerToken: stored?.playerToken,
        });
        if (!ack.ok) return toast(ack.error);
        const id: Identity = { code: ack.code, playerToken: ack.playerToken, hostToken: ack.hostToken };
        saveIdentity(id);
        dispatch({ t: "identity", v: id });
        dispatch({ t: "snapshot", v: ack.snapshot });
        dispatch({ t: "route", v: { name: "room", code: ack.code } });
        navigate(ack.code);
      },
      vote(storyId, round, pick) {
        void simple("vote", { storyId, round, ...pick });
      },
      addStory(title, description) {
        const ht = requireHost();
        if (ht) void simple("addStory", { hostToken: ht, title, description });
      },
      reveal(storyId) {
        const ht = requireHost();
        if (ht) void simple("reveal", { hostToken: ht, storyId });
      },
      reset(storyId) {
        const ht = requireHost();
        if (ht) void simple("reset", { hostToken: ht, storyId });
      },
      nextStory(storyId, finalEstimate, startNext, finalPoints) {
        const ht = requireHost();
        if (ht) void simple("nextStory", { hostToken: ht, storyId, finalEstimate, finalPoints, startNext });
      },
      quickStart() {
        const ht = requireHost();
        if (ht) void simple("quickStart", { hostToken: ht });
      },
      setModel(modelId, outputRatio) {
        const ht = requireHost();
        if (ht) void simple("setModel", { hostToken: ht, modelId, outputRatio });
      },
      goLanding() {
        window.history.pushState({}, "", "/");
        dispatch({ t: "route", v: { name: "landing" } });
      },
      toast,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useApp(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within AppProvider");
  return v;
}
