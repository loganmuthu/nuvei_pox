import { createHash } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function nuveiTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

// Confirmed order for /openOrder and /payment. Assumed (not individually
// confirmed against live docs) for /settleTransaction, /voidTransaction and
// /refundTransaction, which follow the same general v1 pattern — verify
// against your live Nuvei API reference/Postman collection before production.
export function requestChecksum(params: {
  merchantId: string;
  merchantSiteId: string;
  clientRequestId: string;
  amount: string;
  currency: string;
  timeStamp: string;
  secretKey: string;
}): string {
  const { merchantId, merchantSiteId, clientRequestId, amount, currency, timeStamp, secretKey } = params;
  return sha256Hex(merchantId + merchantSiteId + clientRequestId + amount + currency + timeStamp + secretKey);
}

// Confirmed formula for /getSessionToken: merchantId + merchantSiteId + clientRequestId
// + timeStamp + secretKey (no amount/currency slots at all). Passing empty strings for
// amount/currency into requestChecksum() concatenates to the identical string, so this
// is a thin, intention-revealing wrapper rather than a separate algorithm. Also used for
// /getPaymentStatus and /getTransactionDetails, which are lookups (no amount to sign).
export function sessionChecksum(params: {
  merchantId: string;
  merchantSiteId: string;
  clientRequestId: string;
  timeStamp: string;
  secretKey: string;
}): string {
  return requestChecksum({ ...params, amount: "", currency: "" });
}

// DMN authenticity check: SHA-256(secretKey + totalAmount + currency + responseTimeStamp + ppp_TransactionID + Status + productId)
// "+" characters inside field values must be replaced with spaces before concatenation (Nuvei quirk from form-encoding).
// Shared across all three integration flavors — DMN delivery is flow-agnostic in Nuvei's architecture.
export function dmnChecksum(params: {
  secretKey: string;
  totalAmount: string;
  currency: string;
  responseTimeStamp: string;
  pppTransactionId: string;
  status: string;
  productId: string;
}): string {
  const despace = (v: string) => v.replace(/\+/g, " ");
  const { secretKey, totalAmount, currency, responseTimeStamp, pppTransactionId, status, productId } = params;
  return sha256Hex(
    secretKey +
      despace(totalAmount) +
      despace(currency) +
      despace(responseTimeStamp) +
      despace(pppTransactionId) +
      despace(status) +
      despace(productId)
  );
}

// Confirmed formula for Hosted Payment Page (/ppp/purchase.do): SHA-256 of the merchant
// secret key followed by every input parameter's VALUE ONLY (not field names), concatenated
// in the exact order the parameters are submitted. This is a genuinely different algorithm
// from the REST v1 field-based formulas above — HPP is a legacy query-string/form flow.
export function hppChecksum(secretKey: string, orderedValues: string[]): string {
  return sha256Hex(secretKey + orderedValues.join(""));
}

// HPP's return/output parameters are validated the same way DMNs are (both are part of
// Nuvei's "advanceResponseChecksum" family) — assumed, not independently confirmed for HPP
// specifically in the docs pulled for this integration. Verify against your Postman collection.
export const hppOutputChecksum = dmnChecksum;
