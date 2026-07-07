export interface SessionTokenResponse {
  sessionToken: string;
  internalRequestId: number;
  status: "SUCCESS" | "ERROR";
  errCode: number;
  reason: string;
}

export interface PaymentResponse {
  orderId: string;
  transactionId?: string;
  authCode?: string;
  transactionStatus: "APPROVED" | "DECLINED" | "ERROR" | "REDIRECT" | "PENDING";
  // Confirmed to actually appear nested under paymentOption for at least some APMs, despite
  // being documented top-level in Nuvei's published examples — extractRedirectUrl() below
  // checks both locations rather than trusting one shape.
  redirectUrl?: string;
  paymentOption?: { redirectUrl?: string };
  userPaymentOptionId?: string;
  status: "SUCCESS" | "ERROR";
  errCode: number;
  reason: string;
}

export function extractRedirectUrl(result: PaymentResponse): string | undefined {
  return result.redirectUrl ?? result.paymentOption?.redirectUrl;
}

export interface PaymentStatusResponse {
  transactionId?: string;
  transactionStatus?: "APPROVED" | "DECLINED" | "ERROR" | "REDIRECT" | "PENDING";
  paymentMethodErrorCode?: string;
  paymentMethodErrorReason?: string;
  status: "SUCCESS" | "ERROR";
  errCode: number;
  reason: string;
}

export interface TransactionDetailsResponse {
  transactionId?: string;
  transactionStatus?: string;
  transactionType?: string;
  authCode?: string;
  amount?: string;
  currency?: string;
  gwErrorCode?: number;
  gwErrorReason?: string;
  status: "SUCCESS" | "ERROR";
  errCode: number;
  reason: string;
}

// Shared shape for /settleTransaction, /voidTransaction, /refundTransaction
export interface FinancialOperationResponse {
  transactionId?: string;
  transactionStatus?: "APPROVED" | "DECLINED" | "ERROR" | "PENDING";
  transactionType?: "Settle" | "Void" | "Credit";
  authCode?: string;
  status: "SUCCESS" | "ERROR";
  errCode: number;
  reason: string;
}

export interface DmnPayload {
  ppp_status: string;
  PPP_TransactionID: string;
  TransactionID?: string;
  totalAmount: string;
  currency: string;
  Status: string;
  responseTimeStamp: string;
  productId: string;
  payment_method?: string;
  advanceResponseChecksum: string;
  clientUniqueId?: string;
  [key: string]: string | undefined;
}
