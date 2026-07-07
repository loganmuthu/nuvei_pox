import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nuvei: {
    env: process.env.NUVEI_ENV === "live" ? "live" : "test",
    merchantId: required("NUVEI_MERCHANT_ID"),
    merchantSiteId: required("NUVEI_MERCHANT_SITE_ID"),
    secretKey: required("NUVEI_SECRET_KEY"),
  },
} as const;

export const NUVEI_BASE_URL =
  config.nuvei.env === "live"
    ? "https://secure.safecharge.com/ppp/api/v1"
    : "https://ppp-test.nuvei.com/ppp/api/v1";
