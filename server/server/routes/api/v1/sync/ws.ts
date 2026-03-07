import { defineWebSocketHandler } from "h3";
import { hashApiKey } from "#app/utils/auth";
import { getOrmDb } from "#app/utils/db";
import { devices } from "#app/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { syncEventBus, type SyncEventPayload } from "#app/utils/event-bus";

type PeerContext = {
  deviceId: string;
  vaultId: string;
  unsubscribe: (() => void) | null;
};

const peerContexts = new WeakMap<object, PeerContext>();

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
    const url = peer.request?.url || "";
    const params = new URL(url, "http://localhost").searchParams;
    const token = params.get("token") || "";

    const device = authenticateToken(token);
    if (!device) {
      peer.send(JSON.stringify({ type: "error", message: "unauthorized" }));
      peer.close(4001, "unauthorized");
      return;
    }

    const ctx: PeerContext = {
      deviceId: device.id,
      vaultId: device.vaultId,
      unsubscribe: null
    };

    const unsubscribe = syncEventBus.subscribe(device.vaultId, (payload: SyncEventPayload) => {
      if (payload.sourceDeviceId === ctx.deviceId) return;
      peer.send(JSON.stringify({ type: "new_events" }));
    });
    ctx.unsubscribe = unsubscribe;
    peerContexts.set(peer, ctx);

    peer.send(JSON.stringify({
      type: "connected",
      vaultId: device.vaultId,
      deviceId: device.id
    }));
  },

  message(peer, message) {
    try {
      const data = JSON.parse(typeof message === "string" ? message : message.text());
      if (data.type === "ping") {
        peer.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // ignore malformed messages
    }
  },

  close(peer) {
    const ctx = peerContexts.get(peer);
    if (ctx?.unsubscribe) {
      ctx.unsubscribe();
    }
    peerContexts.delete(peer);
  },

  error(peer) {
    const ctx = peerContexts.get(peer);
    if (ctx?.unsubscribe) {
      ctx.unsubscribe();
    }
    peerContexts.delete(peer);
  }
});
