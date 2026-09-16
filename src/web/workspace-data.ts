import type { RecordDoc } from '../shared/contracts';

/** Owns bounded historical-version caching and cancellation of obsolete workspace reads. */
export class WorkspaceData {
  private versions = new Map<string, RecordDoc>();
  private pending = new Map<string, Promise<RecordDoc>>();
  private controller = new AbortController();
  private requests = new Map<string, Promise<any>>();
  private changes = new Map<string, any>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  begin() {
    this.controller.abort();
    this.controller = new AbortController();
    this.requests.clear();
    this.pending.clear();
    this.changes.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async read<T = any>(url: string): Promise<T> {
    if (!this.requests.has(url)) {
      const task = fetch('/api' + url, { signal: this.controller.signal })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || r.statusText);
          return data;
        })
        .finally(() => {
          if (this.requests.get(url) === task) this.requests.delete(url);
        });
      this.requests.set(url, task);
    }
    return this.requests.get(url)!;
  }
  async version(id: string, revision: number): Promise<RecordDoc> {
    const key = `${id}:${revision}`;
    if (this.versions.has(key)) return this.versions.get(key)!;
    if (!this.pending.has(key)) {
      const task = this.read<RecordDoc>(`/records/${id}/versions/${revision}`)
        .then((doc) => {
          this.versions.set(key, doc);
          if (this.versions.size > 200) this.versions.delete(this.versions.keys().next().value!);
          return doc;
        })
        .finally(() => {
          if (this.pending.get(key) === task) this.pending.delete(key);
        });
      this.pending.set(key, task);
    }
    return this.pending.get(key)!;
  }
  event(
    event: any,
    projectId: string,
    consume: (event: any) => Promise<void>,
    failure: (error: Error) => void,
  ) {
    if (event.job_id && event.projectId && event.projectId !== projectId) return;
    if (
      event.kind === 'record' &&
      event.data.projectId !== projectId &&
      event.data.kind !== 'project'
    )
      return;
    const key = event.kind === 'record' ? `record:${event.data.id}` : `job:${event.job_id}`;
    this.changes.set(key, event);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const events = [...this.changes.values()];
      this.changes.clear();
      this.timer = undefined;
      for (const e of events) consume(e).catch(failure);
    }, 100);
  }
  dispose() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.changes.clear();
    this.pending.clear();
    this.versions.clear();
  }
}
