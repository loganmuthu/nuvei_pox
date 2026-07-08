import { config, NUVEI_BASE_URL } from "../config";
import { nuveiTimestamp, requestChecksum, sessionChecksum } from "./checksum";
import {
  FinancialOperationResponse,
  PaymentResponse,
  PaymentStatusResponse,
  SessionTokenResponse,
  TransactionDetailsResponse,
} from "./types";

// Every client function returns the exact request body sent alongside the exact response
// received, so callers (routes) can surface the real Nuvei wire traffic to the UI instead
// of re-describing "what we meant to send" from application-level variables.
export interface NuveiCall<T> {
  request: Record<string, unknown>;
  response: T;
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<NuveiCall<T>> {
  const res = await fetch(`${NUVEI_BASE_URL}/${path}.do`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Nuvei ${path} HTTP ${res.status}`);
  }
  const response = (await res.json()) as T;
  return { request: body, response };
}

export async function getSessionToken(params: { clientRequestId: string }): Promise<NuveiCall<SessionTokenResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = sessionChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<SessionTokenResponse>("getSessionToken", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}

export async function payApm(params: {
  sessionToken: string;
  clientRequestId: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  apmFields: Record<string, string>;
  userTokenId?: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
  phone?: string;
  deviceType?: "DESKTOP" | "SMARTPHONE" | "TABLET";
  ipAddress: string;
  returnBaseUrl: string;
}): Promise<NuveiCall<PaymentResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = requestChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    amount: params.amount,
    currency: params.currency,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  const userDetails = {
    firstName: params.firstName,
    lastName: params.lastName,
    email: params.email,
    country: params.country,
    ...(params.phone ? { phone: params.phone } : {}),
  };

  return post<PaymentResponse>("payment", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    sessionToken: params.sessionToken,
    clientRequestId: params.clientRequestId,
    amount: params.amount,
    currency: params.currency,
    userTokenId: params.userTokenId,
    paymentOption: {
      alternativePaymentMethod: {
        paymentMethod: params.paymentMethod,
        ...params.apmFields,
      },
    },
    billingAddress: userDetails,
    userDetails,
    deviceDetails: {
      ipAddress: params.ipAddress,
      ...(params.deviceType ? { deviceType: params.deviceType } : {}),
    },
    urlDetails: {
      successUrl: `${params.returnBaseUrl}/return/success`,
      failureUrl: `${params.returnBaseUrl}/return/failure`,
      pendingUrl: `${params.returnBaseUrl}/return/pending`,
    },
    timeStamp,
    checksum,
  });
}

// Verifies the outcome of a /payment request server-side. Per Nuvei docs, only valid
// while the session that produced sessionToken is still open, and must not be polled
// repeatedly — repeated calls risk the merchant's IP being blocked. Prefer the DMN for
// routine status confirmation; use this for an on-demand, synchronous re-check.
export async function getPaymentStatus(params: {
  sessionToken: string;
  clientRequestId: string;
}): Promise<NuveiCall<PaymentStatusResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = sessionChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<PaymentStatusResponse>("getPaymentStatus", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    sessionToken: params.sessionToken,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}

// Full detail lookup by transactionId — the durable record to consult after a session
// has expired (getPaymentStatus is session-scoped; this is not).
export async function getTransactionDetails(params: {
  transactionId: string;
  clientRequestId: string;
}): Promise<NuveiCall<TransactionDetailsResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = sessionChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<TransactionDetailsResponse>("getTransactionDetails", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    transactionId: params.transactionId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}

// Captures (settles) a previously authorized transaction. Only applicable when the
// original /payment was submitted as an Auth-only transactionType — most direct-flow
// APMs settle immediately as a Sale and cannot be captured separately.
export async function settleTransaction(params: {
  relatedTransactionId: string;
  authCode: string;
  amount: string;
  currency: string;
  clientUniqueId: string;
  clientRequestId: string;
}): Promise<NuveiCall<FinancialOperationResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = requestChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    amount: params.amount,
    currency: params.currency,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<FinancialOperationResponse>("settleTransaction", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    relatedTransactionId: params.relatedTransactionId,
    authCode: params.authCode,
    amount: params.amount,
    currency: params.currency,
    clientUniqueId: params.clientUniqueId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}

// Cancels an authorization/transaction that hasn't settled yet — only valid in the
// short window before the transaction is transmitted for settlement.
export async function voidTransaction(params: {
  relatedTransactionId: string;
  currency: string;
  clientUniqueId: string;
  clientRequestId: string;
}): Promise<NuveiCall<FinancialOperationResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = requestChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    amount: "",
    currency: params.currency,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<FinancialOperationResponse>("voidTransaction", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    relatedTransactionId: params.relatedTransactionId,
    currency: params.currency,
    clientUniqueId: params.clientUniqueId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}

// Refunds a previously settled transaction. amount + all prior partial refunds must
// not exceed the original sale amount.
export async function refundTransaction(params: {
  relatedTransactionId: string;
  amount: string;
  currency: string;
  clientUniqueId: string;
  clientRequestId: string;
}): Promise<NuveiCall<FinancialOperationResponse>> {
  const timeStamp = nuveiTimestamp();
  const checksum = requestChecksum({
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    clientRequestId: params.clientRequestId,
    amount: params.amount,
    currency: params.currency,
    timeStamp,
    secretKey: config.nuvei.secretKey,
  });

  return post<FinancialOperationResponse>("refundTransaction", {
    merchantId: config.nuvei.merchantId,
    merchantSiteId: config.nuvei.merchantSiteId,
    relatedTransactionId: params.relatedTransactionId,
    amount: params.amount,
    currency: params.currency,
    clientUniqueId: params.clientUniqueId,
    clientRequestId: params.clientRequestId,
    timeStamp,
    checksum,
  });
}
