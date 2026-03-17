import type { ShutdownLogEntry, ShutdownStatus } from "../../shared/types.js";

type ShutdownListener = (status: ShutdownStatus) => void;

export class ShutdownStatusService {
  private status: ShutdownStatus = {
    active: false,
    completed: false,
    failed: false,
    logs: [],
  };

  private listeners = new Set<ShutdownListener>();

  private nextId = 1;

  getSnapshot(): ShutdownStatus {
    return {
      ...this.status,
      logs: [...this.status.logs],
    };
  }

  subscribe(listener: ShutdownListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(message: string): void {
    this.status = {
      active: true,
      completed: false,
      failed: false,
      logs: [],
    };
    this.push("info", message);
  }

  info(message: string): void {
    this.push("info", message);
  }

  error(message: string): void {
    this.push("error", message);
  }

  complete(message: string): void {
    this.push("info", message);
    this.status = {
      ...this.status,
      active: false,
      completed: true,
    };
    this.emit();
  }

  fail(message: string): void {
    this.push("error", message);
    this.status = {
      ...this.status,
      active: false,
      failed: true,
    };
    this.emit();
  }

  private push(level: ShutdownLogEntry["level"], message: string): void {
    const entry: ShutdownLogEntry = {
      id: this.nextId++,
      level,
      message,
      timestamp: new Date().toISOString(),
    };

    this.status = {
      ...this.status,
      logs: [...this.status.logs, entry],
    };

    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
