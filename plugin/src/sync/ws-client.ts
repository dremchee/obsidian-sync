export type WsConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type WsClientOptions = {
  serverUrl: string;
  apiKey: string;
  onNewEvents: () => void;
  onStateChange?: (state: WsConnectionState) => void;
  debugLog?: (msg: string) => void;
};

export class SyncWebSocketClient {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private opts: WsClientOptions;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  get connectionState(): WsConnectionState {
    return this.state;
  }

  connect() {
    if (this.disposed) return;
    this.clearTimers();
    this.doConnect();
  }

  disconnect() {
    this.disposed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  private doConnect() {
    if (this.disposed) return;

    const base = this.opts.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    const url = `${base}/api/v1/sync/ws`;

    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this.log(`ws connecting (attempt ${this.reconnectAttempt})`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: "auth", token: this.opts.apiKey }));
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.startPing();
      this.log("ws connected, auth sent");
    };

    ws.onmessage = (evt) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(String(evt.data));
        if (data.type === "new_events") {
          this.log("ws received new_events");
          this.opts.onNewEvents();
        } else if (data.type === "error") {
          this.log(`ws server error: ${data.message}`);
          if (data.message === "unauthorized") {
            this.disposed = true;
            ws.close();
            this.setState("disconnected");
            return;
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    const delay = this.getReconnectDelay();
    this.setState("reconnecting");
    this.log(`ws reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      this.doConnect();
    }, delay);
  }

  private getReconnectDelay(): number {
    const base = 1000;
    const max = 60_000;
    const exp = Math.min(max, base * (2 ** this.reconnectAttempt));
    return Math.floor(Math.random() * (exp + 1));
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(s: WsConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private log(msg: string) {
    this.opts.debugLog?.(msg);
  }
}
