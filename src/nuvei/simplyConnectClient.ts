import { config, NUVEI_BASE_URL } from "../config";
import { nuveiTimestamp, requestChecksum } from "./checksum";
import { SessionTokenResponse } from "./types";

// Simply Connect's own documented flow uses /openOrder (not /getSessionToken) as step 1 —
// unlike the REST APM flow elsewhere in this project, which was corrected to use
// /getSessionToken per Nuvei's APM-specific integration guide. These are two different
// Nuvei flavors with two different documented session-bootstrap calls; this isn't a
// regression of that earlier fix, it's the other flow's actual requirement.
export interface OpenOrderResponse extends SessionTokenResponse {
  orderId: string;
  clientUniqueId: string;
}

export async function openOrder(params: {
  clientUniqueId: string;
  clientRequestId: string;
  amount: string;
  currency: string;
  userTokenId?: string;
}): Promise<OpenOrderResponse> {
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

  const res = await fetch(`${NUVEI_BASE_URL}/openOrder.do`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchantId: config.nuvei.merchantId,
      merchantSiteId: config.nuvei.merchantSiteId,
      clientUniqueId: params.clientUniqueId,
      clientRequestId: params.clientRequestId,
      amount: params.amount,
      currency: params.currency,
      userTokenId: params.userTokenId,
      timeStamp,
      checksum,
    }),
  });
  if (!res.ok) {
    throw new Error(`Nuvei openOrder HTTP ${res.status}`);
  }
  return res.json() as Promise<OpenOrderResponse>;
}
