import { io, Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@token-poker/shared";

// Connects to the same origin; in dev Vite proxies /socket.io to the Node server.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: true,
  // socket.io-client auto-reconnects with backoff by default.
});
