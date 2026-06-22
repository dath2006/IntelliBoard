/**
 * RaspberryPi3Bridge
 *
 * Manages the WebSocket connection from the frontend to the backend
 * QEMU manager for one Raspberry Pi 3B board instance.
 *
 * Protocol (JSON frames):
 *   Frontend → Backend
 *     { type: 'start_pi', data: { board: 'raspberry-pi-3' } }
 *     { type: 'stop_pi' }
 *     { type: 'serial_input', data: { bytes: number[] } }
 *     { type: 'gpio_in', data: { pin: number, state: 0 | 1 } }
 *
 *   Backend → Frontend
 *     { type: 'serial_output', data: { data: string } }
 *     { type: 'gpio_change',   data: { pin: number, state: 0 | 1 } }
 *     { type: 'system',        data: { event: string, ... } }
 *     { type: 'error',         data: { message: string } }
 */

const API_BASE = (): string =>
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8001/api';

export class RaspberryPi3Bridge {
  readonly boardId: string;

  // Callbacks wired up by useSimulatorStore
  onSerialData: ((char: string) => void) | null = null;
  onPinChange: ((gpioPin: number, state: boolean) => void) | null = null;
  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  onSystemEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;

  private socket: WebSocket | null = null;
  private _connected = false;
  private _shellReady = false;
  // Rolling buffer to detect shell prompt spanning chunk boundaries
  private _serialTail = '';

  onShellReady: (() => void) | null = null;

  constructor(boardId: string) {
    this.boardId = boardId;
  }

  get connected(): boolean {
    return this._connected;
  }

  get shellReady(): boolean {
    return this._shellReady;
  }

  private _checkShellPrompt(text: string): void {
    if (this._shellReady) return;
    // Keep a rolling tail so prompts/markers aren't missed across chunk boundaries.
    // Wide enough to hold the full "job control turned off" marker line.
    this._serialTail = (this._serialTail + text).slice(-160);
    // Primary signal: /bin/sh launched as init prints this exact message right
    // before showing its prompt. 100% reliable for our init=/bin/sh boot.
    const shInitMarker = /can't access tty|job control turned off|Run \/bin\/sh as init/.test(
      this._serialTail,
    );
    // Fallback: a shell prompt ("/ # " or a bare "# ") after a line ending.
    const promptMarker =
      /[\r\n]\/\s*#\s/.test(this._serialTail) || /[\r\n]#\s/.test(this._serialTail);
    if (shInitMarker || promptMarker) {
      this._shellReady = true;
      this._serialTail = '';
      this.onShellReady?.();
    }
  }

  connect(): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;

    const base = API_BASE();
    const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
    const wsUrl =
      base.replace(/^https?:/, wsProtocol) + `/simulation/ws/${encodeURIComponent(this.boardId)}`;

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this._connected = true;
      this.onConnected?.();
      // Tell the backend to boot the Pi
      this._send({ type: 'start_pi', data: { board: 'raspberry-pi-3' } });
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'serial_output': {
          const text = (msg.data.data as string) ?? '';
          this._checkShellPrompt(text);
          if (this.onSerialData) {
            for (const ch of text) this.onSerialData(ch);
          }
          break;
        }
        case 'gpio_change': {
          const pin = msg.data.pin as number;
          const state = (msg.data.state as number) === 1;
          this.onPinChange?.(pin, state);
          break;
        }
        case 'system':
          this.onSystemEvent?.(msg.data.event as string, msg.data);
          break;
        case 'error':
          this.onError?.(msg.data.message as string);
          break;
      }
    };

    socket.onclose = () => {
      this._connected = false;
      this._shellReady = false;
      this._serialTail = '';
      this.socket = null;
      this.onDisconnected?.();
    };

    socket.onerror = () => {
      this.onError?.('WebSocket error');
    };
  }

  disconnect(): void {
    if (this.socket) {
      // Tell backend to stop Pi before closing
      this._send({ type: 'stop_pi' });
      this.socket.close();
      this.socket = null;
    }
    this._connected = false;
  }

  /** Send a byte to the Pi's ttyAMA0 (user serial) */
  sendSerialByte(byte: number): void {
    this._send({ type: 'serial_input', data: { bytes: [byte] } });
  }

  /** Send multiple bytes at once */
  sendSerialBytes(bytes: number[]): void {
    if (bytes.length === 0) return;
    this._send({ type: 'serial_input', data: { bytes } });
  }

  /** Drive a GPIO pin from an external source (e.g. connected Arduino) */
  sendPinEvent(gpioPin: number, state: boolean): void {
    this._send({ type: 'gpio_in', data: { pin: gpioPin, state: state ? 1 : 0 } });
  }

  private _send(payload: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
