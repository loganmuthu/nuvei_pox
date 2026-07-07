import { Router } from "express";
import { randomUUID } from "crypto";
import {
  getPaymentStatus,
  getTransactionDetails,
  refundTransaction,
  settleTransaction,
  voidTransaction,
} from "../nuvei/client";
import { getOrder, saveOrder } from "../store/orderStore";
import { publish } from "../events";

export const financialOpsRouter = Router();

// A payment must have been submitted before any financial op is meaningful — that's the
// same point at which amount/currency get set on the order (see routes/checkout.ts), so
// this narrows all three from optional to required in one place instead of `!`-asserting
// at every call site.
type PaidOrder = ReturnType<typeof getOrder> & {
  amount: string;
  currency: string;
  paymentTransactionId: string;
};

type OrderCheck = { ok: true; order: PaidOrder } | { ok: false; status: number; body: { error: string } };

function requirePaymentTransaction(orderId: string): OrderCheck {
  const order = getOrder(orderId);
  if (!order) return { ok: false, status: 404, body: { error: "Order not found" } };
  if (!order.paymentTransactionId || !order.amount || !order.currency) {
    return { ok: false, status: 400, body: { error: "No payment has been submitted for this order yet" } };
  }
  return { ok: true, order: order as PaidOrder };
}

financialOpsRouter.get("/orders/:orderId/payment-status", async (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  const clientRequestId = randomUUID();
  publish({ type: "payment_status_request", orderId: order.orderId, data: { clientRequestId } });
  const result = await getPaymentStatus({ sessionToken: order.sessionToken, clientRequestId });
  publish({ type: "payment_status_response", orderId: order.orderId, data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "getPaymentStatus failed" });
  }

  if (result.transactionStatus === "APPROVED" || result.transactionStatus === "DECLINED") {
    order.status = result.transactionStatus;
    saveOrder(order);
  }

  res.json(result);
});

financialOpsRouter.get("/orders/:orderId/transaction-details", async (req, res) => {
  const check = requirePaymentTransaction(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const transactionId = (req.query.transactionId as string | undefined) ?? order.paymentTransactionId!;
  const clientRequestId = randomUUID();

  publish({ type: "transaction_details_request", orderId: order.orderId, data: { transactionId } });
  const result = await getTransactionDetails({ transactionId, clientRequestId });
  publish({ type: "transaction_details_response", orderId: order.orderId, data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "getTransactionDetails failed" });
  }

  res.json(result);
});

financialOpsRouter.post("/orders/:orderId/capture", async (req, res) => {
  const check = requirePaymentTransaction(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  if (!order.paymentAuthCode) {
    return res.status(400).json({ error: "No authCode on file — capture only applies to Auth-type transactions" });
  }

  const { amount } = req.body as { amount?: string };
  const captureAmount = amount || order.amount;
  const clientRequestId = randomUUID();

  publish({ type: "capture_request", orderId: order.orderId, data: { amount: captureAmount } });
  const result = await settleTransaction({
    relatedTransactionId: order.paymentTransactionId!,
    authCode: order.paymentAuthCode,
    amount: captureAmount,
    currency: order.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "capture_response", orderId: order.orderId, data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "settleTransaction failed" });
  }

  if (result.transactionId) {
    order.operations.push({
      type: "capture",
      transactionId: result.transactionId,
      status: result.transactionStatus,
      amount: captureAmount,
      timestamp: new Date().toISOString(),
    });
    saveOrder(order);
  }

  res.json(result);
});

financialOpsRouter.post("/orders/:orderId/void", async (req, res) => {
  const check = requirePaymentTransaction(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const clientRequestId = randomUUID();
  publish({ type: "void_request", orderId: order.orderId, data: { transactionId: order.paymentTransactionId } });
  const result = await voidTransaction({
    relatedTransactionId: order.paymentTransactionId!,
    currency: order.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "void_response", orderId: order.orderId, data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "voidTransaction failed" });
  }

  if (result.transactionId) {
    order.operations.push({
      type: "void",
      transactionId: result.transactionId,
      status: result.transactionStatus,
      timestamp: new Date().toISOString(),
    });
    order.status = "DECLINED";
    saveOrder(order);
  }

  res.json(result);
});

financialOpsRouter.post("/orders/:orderId/refund", async (req, res) => {
  const check = requirePaymentTransaction(req.params.orderId);
  if (!check.ok) return res.status(check.status).json(check.body);
  const { order } = check;

  const { amount } = req.body as { amount?: string };
  const refundAmount = amount || order.amount;
  const clientRequestId = randomUUID();

  publish({ type: "refund_request", orderId: order.orderId, data: { amount: refundAmount } });
  const result = await refundTransaction({
    relatedTransactionId: order.paymentTransactionId!,
    amount: refundAmount,
    currency: order.currency,
    clientUniqueId: randomUUID(),
    clientRequestId,
  });
  publish({ type: "refund_response", orderId: order.orderId, data: result });

  if (result.status !== "SUCCESS") {
    return res.status(502).json({ error: result.reason || "refundTransaction failed" });
  }

  if (result.transactionId) {
    order.operations.push({
      type: "refund",
      transactionId: result.transactionId,
      status: result.transactionStatus,
      amount: refundAmount,
      timestamp: new Date().toISOString(),
    });
    saveOrder(order);
  }

  res.json(result);
});
