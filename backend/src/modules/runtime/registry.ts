/**
 * Tiny runtime component registry. A real in-app component registers itself when it is wired into the app; the
 * instrumentation sources endpoint reports a kind CONNECTED only if a component is registered for it. Never register a
 * kind for something that does not really exist.
 */
export type RuntimeKind = 'request' | 'memory' | 'bus' | 'tool' | 'context' | 'error';

export interface RegisteredComponent { kind: RuntimeKind; name: string; description: string }

export class RuntimeRegistry {
  private readonly items = new Map<RuntimeKind, RegisteredComponent>();
  register(c: RegisteredComponent): void { this.items.set(c.kind, c); }
  get(kind: RuntimeKind): RegisteredComponent | undefined { return this.items.get(kind); }
  has(kind: RuntimeKind): boolean { return this.items.has(kind); }
  list(): RegisteredComponent[] { return [...this.items.values()]; }
  clear(): void { this.items.clear(); }
}

/** process-wide registry used by the app and by GET /observability/sources */
export const runtimeRegistry = new RuntimeRegistry();
