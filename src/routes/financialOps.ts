import { Router } from "express";
import { randomUUID } from "crypto";
import {
  getPaymentStatus,
  getTransactionDetails,
  refundTransaction,
  settleTransaction,
  voidTransaction,
} from "../nuvei/client";
import { getOrder, OrderRecord, saveOrder } from "../store/orderStore";
import { publish } from "../events";

export const financialOpsRouter = Router();

function requireOrder(orderId: string): { ok: true; order: OrderRecord } | { ok: false; status: number; body: { error: string } } {
  const order = getOrder(orderId);
  if (!order) return { ok: false, status: 404, body: { error: "Order not found" } };
  return { ok: true, order };
}

// Capture/void/refund don't strictly need a payment made *in this session* — Nuvei's
// settle/void/refund endpoints only need a transactionId + currency (+ authCode for
// capture), not a sessionToken. This lets Step 8 be used standalone against any known
// transaction (e.g. one created outside this tool) by manually entering an override,
// falling back to the current session's own payment when no override is given.
type ResolvedOp =
  | { ok: true; transactionId: string; currency: string }
  | { ok: false; status: number; body: { error: string } };

function resolveTransactionAndCurrency(order: OrderRecord, body: { transactionId?: string; currency?: string }): ResolvedOp {
  const transactionId = body.transactionId?.trim() || order.paymentTransactionId;
  const currency = body.currency?.trim() || order.currency;
  if (!transactionId || !currency) {
    return {
      ok: false,
      status: 400,
      body: { error: "transactionId and currency are required — either from a completed payment in this session, or entered manually" },
    };
  }
  return { ok: true, transactionId, currency };
}

financialOpsRouter.get("/orders/:orderId/payment-status", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const clientRequestId = randomUUID();
  const { request, response } = await getPaymentStatus({ sessionToken: order.sessionToken, clientRequestId });
  publish({ type: "payment_status_request", orderId: order.orderId, data: request });
  publish({ type: "payment_status_response", orderId: order.orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "getPaymentStatus failed", nuveiRequest: request, nuveiResponse: response });
  }

  if (response.transactionStatus === "APPROVED" || response.transactionStatus === "DECLINED") {
    order.status = response.transactionStatus;
    saveOrder(order);
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});

financialOpsRouter.get("/orders/:orderId/transaction-details", async (req, res) => {
  const check = requireOrder(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const transactionId = (req.query.transactionId as string | undefined)?.trim() || order.paymentTransactionId;
  if (!transactionId) {
    return res.status(400).json({ error: "transactionId is required — either from a completed payment or passed as ?transactionId=" });
  }
  const clientRequestId = randomUUID();

  const { request, response } = await getTransactionDetails({ transactionId, clientRequestId });
  publish({ type: "transaction_details_request", orderId: order.orderId, data: request });
  publish({ type: "transaction_details_response", orderId: order.orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "getTransactionDetails failed", nuveiRequest: request, nuveiResponse: response });
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});

financialOpsRouter.post("/orders/:orderId/capture", async (req, res) => {
  const check = requireOrder(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const { amount, transactionId: transactionIdOverride, authCode: authCodeOverride, currency: currencyOverride } =
    req.body as { amount?: string; transactionId?: string; authCode?: string; currency?: string };

  const resolved = resolveTransactionAndCurrency(order, { transactionId: transactionIdOverride, currency: currencyOverride });
  if (!resolved.ok) return res.status(resolved.status).json(resolved.body);

  const authCode = authCodeOverride?.trim() || order.paymentAuthCode;
  if (!authCode) {
    return res.status(400).json({
      error: "authCode is required — either from a completed Auth-type payment in this session, or entered manually",
    });
  }

  const captureAmount = amount || order.amount;
  if (!captureAmount) {
    return res.status(400).json({ error: "amount is required" });
  }
  const clientRequestId = randomUUID();

  const { request, response } = await settleTransaction({
    relatedTransactionId: resolved.transactionId,
    authCode,
    amount: captureAmount,
    currency: resolved.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "capture_request", orderId: order.orderId, data: request });
  publish({ type: "capture_response", orderId: order.orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "settleTransaction failed", nuveiRequest: request, nuveiResponse: response });
  }

  if (response.transactionId) {
    order.operations.push({
      type: "capture",
      transactionId: response.transactionId,
      status: response.transactionStatus,
      amount: captureAmount,
      timestamp: new Date().toISOString(),
    });
    saveOrder(order);
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});

financialOpsRouter.post("/orders/:orderId/void", async (req, res) => {
  const check = requireOrder(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const { transactionId: transactionIdOverride, currency: currencyOverride } = req.body as {
    transactionId?: string;
    currency?: string;
  };
  const resolved = resolveTransactionAndCurrency(order, { transactionId: transactionIdOverride, currency: currencyOverride });
  if (!resolved.ok) return res.status(resolved.status).json(resolved.body);

  const clientRequestId = randomUUID();
  const { request, response } = await voidTransaction({
    relatedTransactionId: resolved.transactionId,
    currency: resolved.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "void_request", orderId: order.orderId, data: request });
  publish({ type: "void_response", orderId: order.orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "voidTransaction failed", nuveiRequest: request, nuveiResponse: response });
  }

  if (response.transactionId) {
    order.operations.push({
      type: "void",
      transactionId: response.transactionId,
      status: response.transactionStatus,
      timestamp: new Date().toISOString(),
    });
    order.status = "DECLINED";
    saveOrder(order);
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});

financialOpsRouter.post("/orders/:orderId/refund", async (req, res) => {
  const check = requireOrder(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const { amount, transactionId: transactionIdOverride, currency: currencyOverride } = req.body as {
    amount?: string;
    transactionId?: string;
    currency?: string;
  };
  const resolved = resolveTransactionAndCurrency(order, { transactionId: transactionIdOverride, currency: currencyOverride });
  if (!resolved.ok) return res.status(resolved.status).json(resolved.body);

  const refundAmount = amount || order.amount;
  if (!refundAmount) {
    return res.status(400).json({ error: "amount is required" });
  }
  const clientRequestId = randomUUID();

  const { request, response } = await refundTransaction({
    relatedTransactionId: resolved.transactionId,
    amount: refundAmount,
    currency: resolved.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "refund_request", orderId: order.orderId, data: request });
  publish({ type: "refund_response", orderId: order.orderId, data: response });

  if (response.status !== "SUCCESS") {
    return res.status(502).json({ error: response.reason || "refundTransaction failed", nuveiRequest: request, nuveiResponse: response });
  }

  if (response.transactionId) {
    order.operations.push({
      type: "refund",
      transactionId: response.transactionId,
      status: response.transactionStatus,
      amount: refundAmount,
      timestamp: new Date().toISOString(),
    });
    saveOrder(order);
  }

  res.json({ ...response, nuveiRequest: request, nuveiResponse: response });
});
