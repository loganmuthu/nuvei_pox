import { config } from "../config";
import { hppChecksum } from "./checksum";

const HPP_BASE_URL =
  config.nuvei.env === "live"
    ? "https://secure.safecharge.com/ppp/purchase.do"
    : "https://ppp-test.safecharge.com/ppp/purchase.do";

function hppTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}.` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

export interface HppRequestParams {
  totalAmount: string;
  currency: string;
  userTokenId: string;
  itemName: string;
  itemAmount: string;
  itemQuantity: string;
  notifyUrl: string;
}

export interface HppRedirectResult {
  redirectUrl: string;
  params: Record<string, string>;
}

// Field order matters for the checksum (§ value-concatenation, not name-based) — this
// exact order must match what's appended to the query string.
export function buildHppRedirectUrl(input: HppRequestParams): HppRedirectResult {
  const params: Record<string, string> = {
    merchant_id: config.nuvei.merchantId,
    merchant_site_id: config.nuvei.merchantSiteId,
    total_amount: input.totalAmount,
    currency: input.currency,
    user_token_id: input.userTokenId,
    item_name_1: input.itemName,
    item_amount_1: input.itemAmount,
    item_quantity_1: input.itemQuantity,
    time_stamp: hppTimestamp(),
    version: "4.0.0",
    notify_url: input.notifyUrl,
  };

  const checksum = hppChecksum(config.nuvei.secretKey, Object.values(params));
  const query = new URLSearchParams({ ...params, checksum }).toString();

  return { redirectUrl: `${HPP_BASE_URL}?${query}`, params: { ...params, checksum } };
}
