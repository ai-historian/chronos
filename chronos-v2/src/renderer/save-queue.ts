// Per-path save serialisation for editor tabs (pure). At most one file/save is in flight per
// path; further requests while it is in flight collapse into one queued save (latest content
// wins), sent only after the reply so it carries the new mtime instead of a stale one.

export interface SaveRequest {
  content: string;
  /** Overwrite without the on-disk change check (expectedMtimeMs -1). */
  force: boolean;
}

export class SaveQueue {
  private inflight = new Map<string, string>();
  private queued = new Map<string, SaveRequest>();

  /** The request to send now, or null when a save for `path` is in flight (then it is queued). */
  request(path: string, req: SaveRequest): SaveRequest | null {
    if (this.inflight.has(path)) {
      this.queued.set(path, req);
      return null;
    }
    this.inflight.set(path, req.content);
    return req;
  }

  /**
   * Settle the in-flight save for `path`. `written` is the content that save carried (undefined
   * for an unsolicited reply or a failure). On success the queued save, if any, becomes the new
   * in-flight save and is returned as `next` for the caller to send; on failure it is dropped.
   */
  settle(path: string, ok: boolean): { written: string | undefined; next: SaveRequest | null } {
    const sent = this.inflight.get(path);
    this.inflight.delete(path);
    const queued = this.queued.get(path) ?? null;
    this.queued.delete(path);
    if (!ok) return { written: undefined, next: null };
    if (queued) this.inflight.set(path, queued.content);
    return { written: sent, next: queued };
  }

  inFlight(path: string): boolean {
    return this.inflight.has(path);
  }

  get busy(): boolean {
    return this.inflight.size > 0;
  }

  clear(path: string): void {
    this.inflight.delete(path);
    this.queued.delete(path);
  }
}
