import { Router } from "express";
import { buildHppRedirectUrl } from "../nuvei/hppClient";
import { hppOutputChecksum } from "../nuvei/checksum";
import { config } from "../config";
import { publish } from "../events";

export const hppRouter = Router();

// HPP is a pure redirect+return flow — there's no session token and nothing to persist
// server-side before the customer completes payment, so this doesn't touch orderStore.
hppRouter.post("/hpp/build-url", (req, res) => {
  const { totalAmount, currency, userTokenId, itemName } = req.body as {
    totalAmount: string;
    currency: string;
    userTokenId: string;
    itemName: string;
  };

  if (!totalAmount || !currency) {
    return res.status(400).json({ error: "totalAmount and currency are required" });
  }

  const notifyUrl = `${req.protocol}://${req.get("host")}/webhooks/nuvei/dmn`;

  const result = buildHppRedirectUrl({
    totalAmount,
    currency,
    userTokenId: userTokenId || "guest-customer",
    itemName: itemName || "Test order",
    itemAmount: totalAmount,
    itemQuantity: "1",
    notifyUrl,
  });

  publish({ type: "hpp_redirect_built", data: result });
  res.json(result);
});

// Nuvei can only redirect a real customer's browser to a publicly reachable successUrl/
// failureUrl/pendingUrl — unreachable from a local dev server, same limitation as DMNs.
// This builds a correctly-signed return payload and validates it through the real
// checksum-verification path, so the flow is demonstrable end-to-end locally.
hppRouter.post("/hpp/simulate-return", (req, res) => {
  const { status, totalAmount, currency, clientUniqueId } = req.body as {
    status: "APPROVED" | "DECLINED";
    totalAmount: string;
    currency: string;
    clientUniqueId?: string;
  };

  const responseTimeStamp = new Date().toISOString();
  const pppTransactionId = `HPP-SIM-${Date.now()}`;
  const productId = "test-product";

  const advanceResponseChecksum = hppOutputChecksum({
    secretKey: config.nuvei.secretKey,
    totalAmount,
    currency,
    responseTimeStamp,
    pppTransactionId,
    status,
    productId,
  });

  const returnPayload = {
    status: status === "APPROVED" ? "OK" : "FAIL",
    Status: status,
    totalAmount,
    currency,
    transactionId: pppTransactionId,
    merchant_unique_id: clientUniqueId ?? "",
    responseTimeStamp,
    productId,
    advanceResponseChecksum,
  };

  // Validate it the same way the merchant's own return-page handler must.
  const expected = hppOutputChecksum({
    secretKey: config.nuvei.secretKey,
    totalAmount,
    currency,
    responseTimeStamp,
    pppTransactionId,
    status,
    productId,
  });
  const validChecksum = expected === returnPayload.advanceResponseChecksum;

  publish({ type: "hpp_return_simulated", data: { returnPayload, validChecksum } });
  res.json({ returnPayload, validChecksum });
});
