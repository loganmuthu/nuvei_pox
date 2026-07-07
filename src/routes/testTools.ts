import { Router } from "express";
import { config } from "../config";
import { dmnChecksum } from "../nuvei/checksum";
import { getOrder } from "../store/orderStore";
import { handleDmn } from "./dmn";

export const testToolsRouter = Router();

// Nuvei can only deliver real DMNs to a publicly reachable HTTPS URL registered
// in the Control Panel — unreachable from a local dev server. This endpoint
// builds a correctly-signed DMN locally so the real-time SSE/DMN UI can be
// demonstrated end-to-end without a live Nuvei sandbox callback.
testToolsRouter.post("/test/simulate-dmn", (req, res) => {
  const { orderId, status } = req.body as { orderId: string; status: "APPROVED" | "DECLINED" };

  const order = getOrder(orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (!order.amount || !order.currency) {
    return res.status(400).json({ error: "No payment has been submitted for this order yet — simulating a DMN before /pay doesn't correspond to anything real" });
  }

  const responseTimeStamp = new Date().toISOString();
  const pppTransactionId = `SIM-${Date.now()}`;
  const productId = "test-product";

  const advanceResponseChecksum = dmnChecksum({
    secretKey: config.nuvei.secretKey,
    totalAmount: order.amount,
    currency: order.currency,
    responseTimeStamp,
    pppTransactionId,
    status,
    productId,
  });

  const result = handleDmn({
    ppp_status: status,
    PPP_TransactionID: pppTransactionId,
    totalAmount: order.amount,
    currency: order.currency,
    Status: status,
    responseTimeStamp,
    productId,
    advanceResponseChecksum,
    clientUniqueId: order.clientUniqueId,
  });

  res.json(result);
});
