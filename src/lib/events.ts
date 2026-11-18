// In-process change feed for the live runsheet (SSE). One app process holds the engine, so no broker is needed.
import { EventEmitter } from "node:events";

declare global {
  var __wonEvents: EventEmitter | undefined;
}

export function events(): EventEmitter {
  if (!globalThis.__wonEvents) {
    globalThis.__wonEvents = new EventEmitter();
    globalThis.__wonEvents.setMaxListeners(200);
  }
  return globalThis.__wonEvents;
}

export function emitChange(day: string) {
  events().emit("change", day);
}
