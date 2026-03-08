import { defineWebSocketHandler } from "h3";
import { hashApiKey } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { devices } from "#app/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { syncEventBus, type SyncEventPayload } from "#app/utils/event-bus";

type PeerContext = {
  authenticated: boolean;
  deviceId: string;
  vaultId: string;
  unsubscribe: (() => void) | null;
  authTimer: ReturnType<typeof setTimeout> | null;
};

const peerContexts = new WeakMap<object, PeerContext>();
const AUTH_TIMEOUT_MS = 5000;

function authenticateToken(token: string) {
  if (!token) return null;
  const hashed = hashApiKey(token);
  const db = getOrmDb();
  const row = db
    .select({ id: devices.id, vaultId: devices.vaultId })
    .from(devices)
    .where(and(eq(devices.apiKeyHash, hashed), isNull(devices.revokedAt)))
    .limit(1)
    .get();
  return row || null;
}

export default defineWebSocketHandler({
  open(peer) {
    const ctx: PeerContext = {
      authenticated: false,
      deviceId: "",
      vaultId: "",
      unsubscribe: null,
      authTimer: setTimeout(() => {
        peer.send(JSON.stringify({ type: "error", message: "auth_timeout" }));
        peer.close(4001, "auth_timeout");
      }, AUTH_TIMEOUT_MS)
    };
    peerContexts.set(peer, ctx);
  },

  message(peer, message) {
    try {
      const ctx = peerContexts.get(peer);
      if (!ctx) return;
      const data = JSON.parse(typeof message === "string" ? message : message.text());
      if (data.type === "auth") {
        const token = typeof data.token === "string" ? data.token : "";
        const device = authenticateToken(token);
        if (!device) {
          peer.send(JSON.stringify({ type: "error", message: "unauthorized" }));
          peer.close(4001, "unauthorized");
          return;
        }
        if (ctx.authTimer) {
          clearTimeout(ctx.authTimer);
          ctx.authTimer = null;
        }
        ctx.authenticated = true;
        ctx.deviceId = device.id;
        ctx.vaultId = device.vaultId;
        ctx.unsubscribe?.();
        ctx.unsubscribe = syncEventBus.subscribe(device.vaultId, (payload: SyncEventPayload) => {
          if (payload.sourceDeviceId === ctx.deviceId) return;
          peer.send(JSON.stringify({ type: "new_events" }));
        });
        peer.send(JSON.stringify({
          type: "connected",
          vaultId: device.vaultId,
          deviceId: device.id
        }));
        return;
      }

      if (!ctx.authenticated) {
        peer.send(JSON.stringify({ type: "error", message: "unauthorized" }));
        peer.close(4001, "unauthorized");
        return;
      }

      if (data.type === "ping") {
        peer.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // ignore malformed messages
    }
  },

  close(peer) {
    const ctx = peerContexts.get(peer);
    if (ctx?.authTimer) {
      clearTimeout(ctx.authTimer);
    }
    if (ctx?.unsubscribe) {
      ctx.unsubscribe();
    }
    peerContexts.delete(peer);
  },

  error(peer) {
    const ctx = peerContexts.get(peer);
    if (ctx?.authTimer) {
      clearTimeout(ctx.authTimer);
    }
    if (ctx?.unsubscribe) {
      ctx.unsubscribe();
    }
    peerContexts.delete(peer);
  }
});
