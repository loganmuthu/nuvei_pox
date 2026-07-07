import { Router } from "express";
import { config } from "../config";
import { dmnChecksum } from "../nuvei/checksum";
import { DmnPayload } from "../nuvei/types";
import { findOrderByClientUniqueId, saveOrder } from "../store/orderStore";
import { publish } from "../events";

export const dmnRouter = Router();

export function handleDmn(payload: DmnPayload): { validChecksum: boolean; orderFound: boolean } {
  const expected = dmnChecksum({
    secretKey: config.nuvei.secretKey,
    totalAmount: payload.totalAmount,
    currency: payload.currency,
    responseTimeStamp: payload.responseTimeStamp,
    pppTransactionId: payload.PPP_TransactionID,
    status: payload.Status,
    productId: payload.productId,
  });
  const validChecksum = expected === payload.advanceResponseChecksum;

  publish({ type: "dmn_received", data: { payload, validChecksum } });

  if (!validChecksum) {
    return { validChecksum: false, orderFound: false };
  }

  const order = payload.clientUniqueId ? findOrderByClientUniqueId(payload.clientUniqueId) : undefined;
  if (!order) {
    return { validChecksum: true, orderFound: false };
  }

  if (order.processedDmnIds.has(payload.PPP_TransactionID)) {
    return { validChecksum: true, orderFound: true };
  }
  order.processedDmnIds.add(payload.PPP_TransactionID);

  if (payload.Status === "APPROVED" || payload.Status === "DECLINED") {
    order.status = payload.Status;
    // payload.totalAmount is the authoritative final amount — reconcile against it,
    // not the amount originally sent in /payment, since some APMs allow it to change.
  }

  saveOrder(order);
  publish({ type: "order_updated", orderId: order.orderId, data: { status: order.status } });

  return { validChecksum: true, orderFound: true };
}

dmnRouter.post("/webhooks/nuvei/dmn", (req, res) => {
  const { validChecksum } = handleDmn(req.body as DmnPayload);
  if (!validChecksum) {
    return res.status(400).send("invalid checksum");
  }
  res.status(200).send("ok");
});
