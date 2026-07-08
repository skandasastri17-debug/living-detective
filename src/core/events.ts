/**
 * Typed publish/subscribe event bus.
 *
 * Systems communicate through the bus instead of holding references to each
 * other. The map of event name → payload type lives with the emitting domain
 * (see GameEvents in game/state.ts and SimBusEvents in sim/engine.ts).
 */

export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const h of [...set]) {
      try {
        (h as Handler<Events[K]>)(payload);
      } catch (err) {
        // A faulty listener must not break other listeners or the sim tick.
        console.error(`[EventBus] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
