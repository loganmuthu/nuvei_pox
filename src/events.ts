import { EventEmitter } from "events";

export interface IntegrationEvent {
  type: string;
  orderId?: string;
  data: unknown;
}

const bus = new EventEmitter();
bus.setMaxListeners(50);

export function publish(event: IntegrationEvent): void {
  bus.emit("event", event);
}

export function subscribe(listener: (event: IntegrationEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
