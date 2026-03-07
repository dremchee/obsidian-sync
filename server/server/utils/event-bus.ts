type SyncEventPayload = {
  eventId?: number;
  fileId: string;
  revisionId: string;
  sourceDeviceId: string;
};

type Listener = (payload: SyncEventPayload) => void;

class SyncEventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(vaultId: string, listener: Listener): () => void {
    let set = this.listeners.get(vaultId);
    if (!set) {
      set = new Set();
      this.listeners.set(vaultId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(vaultId);
    };
  }

  emit(vaultId: string, payload: SyncEventPayload) {
    const set = this.listeners.get(vaultId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(payload);
      } catch {
        // listener errors must not break the emit loop
      }
    }
  }
}

export const syncEventBus = new SyncEventBus();
export type { SyncEventPayload };
