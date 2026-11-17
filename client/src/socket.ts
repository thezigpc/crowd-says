import { io, type Socket } from "socket.io-client";
import { createCall, serverBase, serverOrigin, socketPath, SOCKET_OPTIONS } from "@bargames/gamekit/client";
import type { ClientToServerEvents, ServerToClientEvents } from "@crowdsays/shared";

// In dev, Vite serves the client on :5183 while the server runs on :3013. In production the
// server serves the built client itself (one origin). Under a path prefix (a Bar Games box's
// https://<venue>/crowdsays/, or BASE_PATH behind your own proxy) the server injects the
// prefix into index.html: serverUrl carries it for fetches, and socket.io gets the bare
// origin plus a `path`.
const dev = { vitePort: 5183, serverPort: 3013 };
export const serverUrl = serverBase(dev);

// WebSocket first (the kit's SOCKET_OPTIONS), polling as a fallback.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverOrigin(dev), {
  ...SOCKET_OPTIONS,
  path: socketPath(),
});

const kitCall = createCall(socket as unknown as Parameters<typeof createCall>[0]);

/** Emit with an ack as a promise. Rejects with the server's error message. */
export function call<T = object>(event: keyof ClientToServerEvents, ...args: unknown[]): Promise<T> {
  return kitCall<T>(event, ...args);
}
