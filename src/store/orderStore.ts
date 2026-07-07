// In-memory demo store. Replace with a real database table keyed by orderId
// before going to production — this resets on every process restart.

export interface OperationLogEntry {
  type: "payment" | "capture" | "void" | "refund";
  transactionId: string;
  status?: string;
  amount?: string;
  timestamp: string;
}

export interface OrderRecord {
  orderId: string;
  clientUniqueId: string;
  sessionToken: string;
  // Not known until /payment is called — /getSessionToken never sees these.
  amount?: string;
  currency?: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "ERROR";
  processedDmnIds: Set<string>;
  nuveiOrderId?: string;
  paymentTransactionId?: string;
  paymentAuthCode?: string;
  operations: OperationLogEntry[];
}

const orders = new Map<string, OrderRecord>();

export function saveOrder(order: OrderRecord): void {
  orders.set(order.orderId, order);
}

export function getOrder(orderId: string): OrderRecord | undefined {
  return orders.get(orderId);
}

export function findOrderByClientUniqueId(clientUniqueId: string): OrderRecord | undefined {
  for (const order of orders.values()) {
    if (order.clientUniqueId === clientUniqueId) return order;
  }
  return undefined;
}
