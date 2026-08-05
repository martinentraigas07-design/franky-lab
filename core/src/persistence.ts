/** FRANKY LAB — Core / Persistencia (equivalente a Preferences.h / NVS). */
export interface NVSStore {
  get<T>(namespace: string, key: string): T | undefined;
  set<T>(namespace: string, key: string, value: T): void;
}

export class InMemoryNVS implements NVSStore {
  private data = new Map<string, unknown>();
  private k(ns: string, key: string) {
    return `${ns}::${key}`;
  }
  get<T>(ns: string, key: string): T | undefined {
    return this.data.get(this.k(ns, key)) as T | undefined;
  }
  set<T>(ns: string, key: string, value: T): void {
    this.data.set(this.k(ns, key), value);
  }
}
