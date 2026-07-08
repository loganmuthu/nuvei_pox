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

  const { request, response } = await openOrder({ clientUniqueId, clientRequestId, amount, currency });
  publish({ type: "sc_open_order_request", data: request });
  publish({ type: "sc_open_order_response", data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "Failed to open order", nuveiRequest: request, nuveiResponse: response });
  }

  const orderId = randomUUID();
  saveOrder({
    orderId,
    clientUniqueId,
    sessionToken: response.sessionToken,
    amount,
    currency,
    status: "PENDING",
    processedDmnIds: new Set(),
    operations: [],
  });

  // merchantId/merchantSiteId are not secret — checkout.js needs them client-side to render.
  res.status(201).json({
    orderId,
    sessionToken: response.sessionToken,
    nuveiOrderId: response.orderId,
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    env: config.nuvei.env === "live" ? "prod" : "int",
    nuveiRequest: request,
    nuveiResponse: response,
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
  const { request, response } = await getPaymentStatus({ sessionToken: order.sessionToken, clientRequestId });
  publish({ type: "sc_payment_status_request", orderId: order.orderId, data: request });
  publish({ type: "sc_payment_status_response", orderId: order.orderId, data: response });

  if (response.status === "SUCCESS" && (response.transactionStatus === "APPROVED" || response.transactionStatus === "DECLINED")) {
    order.status = response.transactionStatus;
    saveOrder(order);
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});
