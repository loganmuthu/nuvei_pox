import { Router } from "express";
import { randomUUID } from "crypto";
import { openOrder } from "../nuvei/simplyConnectClient";
import { getPaymentStatus } from "../nuvei/client";
import { getOrder, saveOrder } from "../store/orderStore";
import { publish } from "../events";
import { config } from "../config";

export const simplyConnectRouter = Router();

// Step 1 — must run server-side: /openOrder requires merchantSecretKey to compute the
// checksum, which must never reach the browser. The frontend only ever sees sessionToken.
simplyConnectRouter.post("/simply-connect/session", async (req, res) => {
  const { amount, currency } = req.body as { amount: string; currency: string };
  if (!amount || !currency) {
    return res.status(400).json({ error: "amount and currency are required" });
  }

  const clientUniqueId = randomUUID();
  const clientRequestId = randomUUID();

  publish({ type: "sc_open_order_request", data: { clientUniqueId, amount, currency } });
  const result = await openOrder({ clientUniqueId, clientRequestId, amount, currency });
  publish({ type: "sc_open_order_response", data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "Failed to open order" });
  }

  const orderId = randomUUID();
  saveOrder({
    orderId,
    clientUniqueId,
    sessionToken: result.sessionToken,
    amount,
    currency,
    status: "PENDING",
    processedDmnIds: new Set(),
    operations: [],
  });

  // merchantId/merchantSiteId are not secret — checkout.js needs them client-side to render.
  res.status(201).json({
    orderId,
    sessionToken: result.sessionToken,
    nuveiOrderId: result.orderId,
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    env: config.nuvei.env === "live" ? "prod" : "int",
  });
});

// Step 3 (Option B) — cross-check the client-side checkout() result server-side, same
// getPaymentStatus() the REST APM flow uses. Recommended alternative: trust the DMN instead.
simplyConnectRouter.get("/simply-connect/orders/:orderId/status", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const clientRequestId = randomUUID();
  publish({ type: "sc_payment_status_request", orderId: order.orderId, data: { clientRequestId } });
  const result = await getPaymentStatus({ sessionToken: order.sessionToken, clientRequestId });
  publish({ type: "sc_payment_status_response", orderId: order.orderId, data: result });

  if (result.status === "SUCCESS" && (result.transactionStatus === "APPROVED" || result.transactionStatus === "DECLINED")) {
    order.status = result.transactionStatus;
    saveOrder(order);
  }

  res.json(result);
});
