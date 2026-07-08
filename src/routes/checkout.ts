import { Router } from "express";
import { randomUUID } from "crypto";
import { getSessionToken, payApm } from "../nuvei/client";
import { extractRedirectUrl } from "../nuvei/types";
import { getOrder, saveOrder } from "../store/orderStore";
import { APM_CATALOG, findApm } from "../nuvei/apmCatalog";
import { publish } from "../events";

export const checkoutRouter = Router();

checkoutRouter.get("/apms", (_req, res) => {
  res.json(APM_CATALOG);
});

// /getSessionToken takes no business input at all — merchantId/merchantSiteId/
// merchantSecretKey come from config (env), and clientRequestId is generated here.
// amount/currency belong to the /payment slice below, not this one.
checkoutRouter.post("/orders", async (_req, res) => {
  const clientUniqueId = randomUUID();
  const clientRequestId = randomUUID();

  const { request, response } = await getSessionToken({ clientRequestId });
  publish({ type: "session_request", data: request });
  publish({ type: "session_response", data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({
      error: response.reason || "Failed to get session token",
      nuveiRequest: request,
      nuveiResponse: response,
    });
  }

  const orderId = randomUUID();
  saveOrder({
    orderId,
    clientUniqueId,
    sessionToken: response.sessionToken,
    status: "PENDING",
    processedDmnIds: new Set(),
    operations: [],
  });

  res.status(201).json({ orderId, nuveiRequest: request, nuveiResponse: response });
});

checkoutRouter.post("/orders/:orderId/pay", async (req, res) => {
  const { orderId } = req.params;
  const { amount, currency, paymentMethod, fields, email, firstName, lastName, country, phone, deviceType } =
    req.body as {
      amount: string;
      currency: string;
      paymentMethod: string;
      fields: Record<string, string>;
      email: string;
      firstName: string;
      lastName: string;
      country: string;
      phone?: string;
      deviceType?: "DESKTOP" | "SMARTPHONE" | "TABLET";
    };

  // amount/currency are required here, not at session creation — /payment's checksum
  // is computed from them (see src/nuvei/checksum.ts), unlike /getSessionToken's.
  if (!amount || !currency) {
    return res.status(400).json({ error: "amount and currency are required" });
  }

  const apm = findApm(paymentMethod);
  if (!apm) {
    return res.status(400).json({ error: `Unknown paymentMethod: ${paymentMethod}` });
  }

  const missing = apm.fields.filter((f) => f.required && !fields?.[f.name]).map((f) => f.name);
  if (apm.needsPhone && !phone) missing.push("phone");
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  const order = getOrder(orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const { request, response } = await payApm({
    sessionToken: order.sessionToken,
    clientRequestId: randomUUID(),
    amount,
    currency,
    paymentMethod,
    apmFields: fields ?? {},
    email,
    firstName,
    lastName,
    country,
    phone,
    deviceType,
    ipAddress: req.ip ?? "0.0.0.0",
    returnBaseUrl: `${req.protocol}://${req.get("host")}`,
  });

  publish({ type: "payment_request", orderId, data: request });
  publish({ type: "payment_response", orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({
      error: response.reason || "Payment request failed",
      nuveiRequest: request,
      nuveiResponse: response,
    });
  }

  order.amount = amount;
  order.currency = currency;
  order.nuveiOrderId = response.orderId;
  order.paymentTransactionId = response.transactionId;
  order.paymentAuthCode = response.authCode;
  if (response.transactionId) {
    order.operations.push({
      type: "payment",
      transactionId: response.transactionId,
      status: response.transactionStatus,
      amount,
      timestamp: new Date().toISOString(),
    });
  }
  saveOrder(order);

  // transactionStatus here is provisional for async/redirect APMs — final truth arrives via DMN.
  res.json({
    transactionStatus: response.transactionStatus,
    transactionId: response.transactionId,
    redirectUrl: extractRedirectUrl(response),
    nuveiRequest: request,
    nuveiResponse: response,
  });
});

checkoutRouter.get("/orders/:orderId", (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json({
    orderId: order.orderId,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    nuveiOrderId: order.nuveiOrderId,
    paymentTransactionId: order.paymentTransactionId,
    operations: order.operations,
  });
});
