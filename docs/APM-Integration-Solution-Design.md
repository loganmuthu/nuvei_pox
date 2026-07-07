# Nuvei APM REST API Integration — Solution Design

**Scope:** Server-to-server REST API integration of the following Alternative Payment Methods (APMs) via Nuvei's `/payment` endpoint: **Zip, Twint, MobilePay, Fawry, LINE Pay, PayPay, GrabPay**.

**Reference:** [Nuvei APM Integrations & Flows](https://docs.nuvei.com/documentation/apms-overview/apm-integrations/#apm-rest-api-integration)

**Status of source data:** Every `paymentMethod` code, flow type, and field list below was pulled directly from Nuvei's published docs. Two are flagged as incomplete in Nuvei's own documentation (Fawry, Twint/GrabPay field-level detail) — see the note at the end of each of those sections.

**Note on scope:** This document covers Nuvei's **REST API** flavor only, in depth. The test console (`public/`) also implements Nuvei's other two integration flavors side by side, switchable via a horizontal nav bar:

| Flavor | Console page | Session call | Client involvement | Checksum family |
|---|---|---|---|---|
| REST API (this document) | `test.html` | `/getSessionToken` | None — pure server-to-server | Field-based SHA-256 (§1.3) |
| Hosted Payment Page (HPP) | `hpp.html` | None — stateless redirect | Full browser redirect to Nuvei's hosted page | Value-concatenation SHA-256 (different formula — see `src/nuvei/checksum.ts:hppChecksum`) |
| Simply Connect | `simply-connect.html` | `/openOrder` (this flavor's own documented session call, distinct from REST API's `/getSessionToken`) | Embedded `checkout()` widget via `checkout.js` | Same field-based formula as `/openOrder`/`/payment` |

All three funnel into the same DMN webhook (`/webhooks/nuvei/dmn`) — DMN delivery is flow-agnostic in Nuvei's architecture, so the validation logic in §4 of this document applies regardless of which flavor initiated the payment. HPP and Simply Connect are implemented at the same fidelity as the REST API flow in this codebase (real checksum computation, real endpoint calls against the sandbox) but don't yet have their own dedicated solution-design write-ups — this document remains the deep-dive reference for REST API + the 7 APMs above.

---

## 1. Overview

### 1.1 Integration pattern

This design uses **`/getSessionToken`** rather than `/openOrder` to authenticate — a lighter, "pure API call" session bootstrap that doesn't create a Nuvei order or take `amount`/`currency` as input (those are only needed later, at the `/payment` step). Post-payment, the flow adds on-demand verification (`/getPaymentStatus`, `/getTransactionDetails`) and money-movement operations (`/settleTransaction`, `/voidTransaction`, `/refundTransaction`).

```
Merchant Backend                     Nuvei                          Customer / APM Provider
------------------                   -----                          ------------------------
1. POST /getSessionToken ──────────▶
                          ◀──────────  sessionToken (no order created, ~10 min TTL)

2. Present APM list to customer, collect any APM-specific fields (if required)

3. POST /payment
   paymentOption.alternativePaymentMethod
   { paymentMethod: "apmgw_<code>", ...fields }
                         ───────────▶
                         ◀───────────  transactionStatus = REDIRECT
                                       redirectUrl = <provider auth URL>
                                       orderId, transactionId, authCode

4. Redirect customer to redirectUrl  ─────────────────────────────▶  Customer authenticates
                                                                      with provider (app/QR/web)
                                     ◀─────────────────────────────  Provider confirms to Nuvei

5. Nuvei → Merchant DMN (async)      ◀───────────  Final transactionStatus (source of truth)
   (webhook, signed with checksum)

6. On-demand verification (either, not required if the DMN is trusted):
   GET-equivalent POST /getPaymentStatus   ───────▶  (session-scoped; only while sessionToken is still valid)
   POST /getTransactionDetails             ───────▶  (durable; by transactionId, works after session expiry)

7. Post-payment financial operations (see §5):
   POST /settleTransaction (capture) | /voidTransaction | /refundTransaction
```

**All seven APMs in this document are redirect-flow APMs** (unlike BLIK, which is direct-flow). This means:
- The synchronous `/payment` response returns `transactionStatus: "REDIRECT"` and a `redirectUrl`, not an immediate APPROVED/DECLINED.
- The customer must be redirected to `redirectUrl` to complete authentication with the APM provider (their bank, wallet app, or a QR code, depending on the APM).
- The **DMN webhook is the only authoritative source of final status** — never finalize an order from the redirect return alone. `/getPaymentStatus`/`/getTransactionDetails` are for on-demand, human-triggered re-checks (support tooling, reconciliation), not a replacement for the DMN.

### 1.2 Common request parameters (all APMs)

| Parameter | Location | Required | Notes |
|---|---|---|---|
| `merchantId` | top-level | Yes | From Nuvei Control Panel |
| `merchantSiteId` | top-level | Yes | From Nuvei Control Panel |
| `sessionToken` | top-level | Yes | From `/getSessionToken` (~10 min TTL) |
| `clientRequestId` | top-level | Yes | Unique per request; idempotency key |
| `amount` | top-level | Yes | Transaction amount |
| `currency` | top-level | Yes | ISO 4217, must match APM's supported currency |
| `userTokenId` | top-level | Recommended | Merchant's internal customer ID |
| `timeStamp` | top-level | Yes | `YYYYMMDDHHmmss` |
| `checksum` | top-level | Yes | SHA-256, see §1.3 |
| `paymentOption.alternativePaymentMethod.paymentMethod` | nested | Yes | `apmgw_<code>` — see per-APM section |
| `deviceDetails.ipAddress` | nested | Yes | Customer's IP |
| `billingAddress` | nested | Yes | Typically `firstName`, `lastName`, `email`, `country` (some APMs add `phone`) |
| `userDetails` | nested | Yes | Mirrors `billingAddress` for most APMs |
| `urlDetails.successUrl` / `failureUrl` / `pendingUrl` | nested | APM-dependent | Required for LINE Pay and PayPay; recommended for all redirect APMs |

### 1.3 Checksum

Two confirmed variants, both SHA-256, both hex-encoded:

```
# /payment (and, in this implementation, /settleTransaction, /refundTransaction — see §5)
checksum = SHA256( merchantId + merchantSiteId + clientRequestId + amount + currency + timeStamp + merchantSecretKey )

# /getSessionToken (and, in this implementation, /getPaymentStatus, /getTransactionDetails — see §3)
checksum = SHA256( merchantId + merchantSiteId + clientRequestId + timeStamp + merchantSecretKey )
```

The second formula is not a different algorithm so much as the first with `amount`/`currency` omitted entirely — since string concatenation with those fields present-but-empty produces an identical result, one implementation can serve both by passing empty strings. `/payment`'s formula is confirmed against Nuvei's `/openOrder` reference (same pattern) and `/getSessionToken`'s is independently confirmed in Nuvei's docs. `/settleTransaction`, `/voidTransaction`, and `/refundTransaction` are **assumed** to follow the same respective pattern (financial ops with an amount use the first formula; `/voidTransaction`, which has no amount, uses the second) — this is not individually confirmed in Nuvei's public docs and should be verified against your live Postman collection before production (see §7).

---

## 2. Per-APM integration details

### 2.1 Zip

| | |
|---|---|
| **Category** | Buy Now Pay Later (BNPL) |
| **paymentMethod code** | `apmgw_zip` |
| **Flow type** | Redirect |
| **Countries** | Australia, United States |
| **Currencies** | AUD, USD |
| **Refunds** | Partial refunds supported |
| **Payouts / Recurring** | Not supported |

**Description:** Zip is a global BNPL provider (Zip Pay / Zip Money) that lets customers split a purchase into installments. The customer authenticates on Zip's hosted page and selects an installment plan before Nuvei confirms the transaction.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-zip-0001",
  "amount": "150.00",
  "currency": "AUD",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_zip"
    }
  },
  "billingAddress": { "firstName": "Alex", "lastName": "Nguyen", "email": "alex@example.com", "country": "AU" },
  "userDetails": { "firstName": "Alex", "lastName": "Nguyen", "email": "alex@example.com", "country": "AU" },
  "deviceDetails": { "ipAddress": "203.0.113.10" },
  "urlDetails": { "successUrl": "https://merchant.example.com/return/success", "failureUrl": "https://merchant.example.com/return/failure", "pendingUrl": "https://merchant.example.com/return/pending" },
  "timeStamp": "20260702101500",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512340",
  "transactionId": "119004521",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://checkout.zip.co/session/abc123",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Notes:** Zip sandbox testing is documented as Australia-only. Confirm US availability with your account manager before enabling `USD`/US flows in production.

---

### 2.2 Twint

| | |
|---|---|
| **Category** | E-wallet / QR payment |
| **paymentMethod code** | `apmgw_TWINT` |
| **Flow type** | Redirect |
| **Countries** | Switzerland |
| **Currencies** | CHF |

**Description:** Twint is a Swiss mobile payment app. The customer is redirected to a Twint authentication/QR flow and confirms the payment in the Twint app.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-twint-0001",
  "amount": "45.00",
  "currency": "CHF",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_TWINT"
    }
  },
  "billingAddress": { "firstName": "Lena", "lastName": "Meier", "email": "lena@example.com", "country": "CH" },
  "userDetails": { "firstName": "Lena", "lastName": "Meier", "email": "lena@example.com", "country": "CH" },
  "deviceDetails": { "ipAddress": "203.0.113.11" },
  "timeStamp": "20260702101600",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512341",
  "transactionId": "119004522",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://pay.twint.ch/session/def456",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Note on source completeness:** Nuvei's APM input-parameters reference confirms the code `apmgw_TWINT` and redirect flow but lists **no APM-specific fields** beyond the common set in §1.2 — only `billingAddress`/`userDetails`. Twint does not have a standalone documentation page at the time of writing (it may be bundled under Nuvei's "Swiss Payments" guide); confirm with your Nuvei account manager whether any additional fields apply to your merchant configuration before going live.

---

### 2.3 MobilePay

| | |
|---|---|
| **Category** | Mobile wallet / bank app |
| **paymentMethod code** | `apmgw_MobilePay` |
| **Flow type** | Redirect |
| **Countries** | Denmark, Finland |
| **Currencies** | DKK, EUR, NOK, SEK |

**Description:** MobilePay is a Danish/Finnish mobile payment app. The customer is redirected to a URL that opens the MobilePay app (mobile) or displays a QR/web flow (desktop) to authorize payment.

**Required fields beyond the common set:**

| Field | Location | Required | Notes |
|---|---|---|---|
| `deviceType` | `deviceDetails` | Yes | `DESKTOP` \| `SMARTPHONE` \| `TABLET` — determines whether the customer gets an app-deep-link or a web/QR redirect URL |
| `phone` | `userDetails` | Yes | Full international format, e.g. `00451234567` |

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-mobilepay-0001",
  "amount": "220.00",
  "currency": "DKK",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_MobilePay"
    }
  },
  "billingAddress": { "firstName": "Mikkel", "lastName": "Jensen", "email": "mikkel@example.com", "country": "DK" },
  "userDetails": { "firstName": "Mikkel", "lastName": "Jensen", "email": "mikkel@example.com", "country": "DK", "phone": "004512345678" },
  "deviceDetails": { "ipAddress": "203.0.113.12", "deviceType": "SMARTPHONE" },
  "timeStamp": "20260702101700",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512342",
  "transactionId": "119004523",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://mobilepay.dk/pay/session/ghi789",
  "userPaymentOptionId": "up-556677",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Notes:**
- Do not rely on session state for returning customers — always await the DMN.
- Customers can cancel mid-flow from within the MobilePay app; your backend will only learn this via the DMN (`Status: DECLINED`), not via any synchronous signal — do not implement a client-side timeout that marks the order failed before the DMN arrives.

---

### 2.4 Fawry

| | |
|---|---|
| **Category** | Cash voucher / reference-number payment |
| **paymentMethod code** | `apmgw_Local_payments_Africa` (bundled — see note) |
| **Flow type** | Redirect |
| **Countries** | Egypt |
| **Currencies** | EGP |

**Description:** Fawry is an Egyptian cash-voucher payment method. Nuvei generates a reference number; the customer completes payment either in the Fawry mobile app or at a physical Fawry outlet using that reference number. Settlement is therefore asynchronous and can take longer than a typical redirect APM — the DMN may arrive well after the initial request.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-fawry-0001",
  "amount": "500.00",
  "currency": "EGP",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_Local_payments_Africa"
    }
  },
  "billingAddress": { "firstName": "Omar", "lastName": "Hassan", "email": "omar@example.com", "country": "EG", "phone": "0201234567" },
  "userDetails": { "firstName": "Omar", "lastName": "Hassan", "email": "omar@example.com", "country": "EG", "phone": "0201234567" },
  "deviceDetails": { "ipAddress": "203.0.113.13" },
  "timeStamp": "20260702101800",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512343",
  "transactionId": "119004524",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://pay.fawry.com/session/jkl012",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Note on source completeness — important:** Nuvei's public documentation does **not** expose an isolated `apmgw_Fawry` code. Fawry is documented only as one option within the bundled **Local Payments Africa** integration (`apmgw_Local_payments_Africa`), which appears to route to Fawry, or a different Egyptian/African rail, based on merchant configuration and/or customer selection rather than a request parameter documented publicly. **Before implementing:** confirm with your Nuvei account manager (a) whether Fawry has its own dedicated `paymentMethod` code for your merchant account, and (b) how the voucher reference number is surfaced back to the customer (in the redirect page itself, or in a response field) — this page's docs describe the UX but not the exact field name.

---

### 2.5 LINE Pay

| | |
|---|---|
| **Category** | E-wallet |
| **paymentMethod code** | `apmgw_LINE_Pay` |
| **Flow type** | Redirect |
| **Countries** | Japan (primary), Taiwan |
| **Currencies** | JPY |
| **Refunds** | Supported |
| **Payouts / Recurring** | Not supported |

**Description:** LINE Pay is a wallet embedded in the LINE messaging app. The customer is redirected to LINE Pay's site, authenticates, and completes payment via the LINE Pay app.

**Required fields beyond the common set:**

| Field | Location | Required | Notes |
|---|---|---|---|
| `successUrl`, `failureUrl`, `pendingUrl` | `urlDetails` | Yes | Supports deep-link parameters back into your app |

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-linepay-0001",
  "amount": "3000",
  "currency": "JPY",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_LINE_Pay"
    }
  },
  "billingAddress": { "firstName": "Yuki", "lastName": "Tanaka", "email": "yuki@example.com", "country": "JP" },
  "userDetails": { "firstName": "Yuki", "lastName": "Tanaka", "email": "yuki@example.com", "country": "JP" },
  "deviceDetails": { "ipAddress": "203.0.113.14" },
  "urlDetails": {
    "successUrl": "https://merchant.example.com/return/success",
    "failureUrl": "https://merchant.example.com/return/failure",
    "pendingUrl": "https://merchant.example.com/return/pending"
  },
  "timeStamp": "20260702101900",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512344",
  "transactionId": "119004525",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://pay.line.me/session/mno345",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

---

### 2.6 PayPay

| | |
|---|---|
| **Category** | E-wallet |
| **paymentMethod code** | `apmgw_PayPay` |
| **Flow type** | Redirect |
| **Countries** | Japan |
| **Currencies** | JPY |
| **Refunds** | Supported |
| **Payouts / Recurring** | Not supported |

**Description:** PayPay is a Japanese QR/e-wallet payment method. Mobile customers are redirected into the PayPay app; desktop customers scan a QR code rendered on the redirect page and confirm in the app.

**Required fields beyond the common set:**

| Field | Location | Required | Notes |
|---|---|---|---|
| `successUrl`, `failureUrl`, `pendingUrl` | `urlDetails` | Yes | |

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-paypay-0001",
  "amount": "1500",
  "currency": "JPY",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_PayPay"
    }
  },
  "billingAddress": { "firstName": "Sora", "lastName": "Watanabe", "email": "sora@example.com", "country": "JP" },
  "userDetails": { "firstName": "Sora", "lastName": "Watanabe", "email": "sora@example.com", "country": "JP" },
  "deviceDetails": { "ipAddress": "203.0.113.15" },
  "urlDetails": {
    "successUrl": "https://merchant.example.com/return/success",
    "failureUrl": "https://merchant.example.com/return/failure",
    "pendingUrl": "https://merchant.example.com/return/pending"
  },
  "timeStamp": "20260702102000",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512345",
  "transactionId": "119004526",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://qr.paypay.ne.jp/session/pqr678",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Notes:** Sandbox lets you simulate outcomes directly on the redirect page — a blue "Pay" button for APPROVED, a red "Cancel" button for DECLINED — useful for scripted end-to-end tests without a real PayPay account.

---

### 2.7 GrabPay

| | |
|---|---|
| **Category** | E-wallet (Southeast Asia) |
| **paymentMethod code** | `apmgw_Grabpay` (general) or `apmgw_Grabpay_Malaysia` (Malaysia-specific variant) |
| **Flow type** | Redirect |
| **Countries** | Malaysia (confirmed variant); broader SEA coverage per Grab's own footprint — confirm per-country availability with Nuvei |
| **Currencies** | MYR (Malaysia); confirm others per country |

**Description:** GrabPay is the e-wallet embedded in the Grab super-app, used across Southeast Asia. The customer is redirected to Grab's authentication page/app to confirm payment.

**Required fields beyond the common set:**

| Field | Location | Required | Notes |
|---|---|---|---|
| `firstName`, `lastName`, `email` | `userDetails` | Yes | Explicitly called out as mandatory in Nuvei's APM parameter reference (in addition to the general common-set requirement) |

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "{{sessionToken}}",
  "clientRequestId": "req-grabpay-0001",
  "amount": "80.00",
  "currency": "MYR",
  "userTokenId": "cust-8842",
  "paymentOption": {
    "alternativePaymentMethod": {
      "paymentMethod": "apmgw_Grabpay_Malaysia"
    }
  },
  "billingAddress": { "firstName": "Aisha", "lastName": "Rahman", "email": "aisha@example.com", "country": "MY" },
  "userDetails": { "firstName": "Aisha", "lastName": "Rahman", "email": "aisha@example.com", "country": "MY" },
  "deviceDetails": { "ipAddress": "203.0.113.16" },
  "timeStamp": "20260702102100",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "orderId": "271512346",
  "transactionId": "119004527",
  "transactionStatus": "REDIRECT",
  "redirectUrl": "https://grab.com/pay/session/stu901",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Note on source completeness:** GrabPay does not have a standalone documentation page in Nuvei's public docs (it isn't listed under the Asia-Pacific guides index) — the code and field requirements above come from Nuvei's consolidated APM input-parameters reference table. Confirm with Nuvei which specific country variants (`apmgw_Grabpay_Malaysia` vs. the general `apmgw_Grabpay`) are enabled on your merchant account before building country-specific logic.

---

## 3. Session, verification & transaction-lookup APIs

### 3.1 `/getSessionToken`

Replaces `/openOrder` in this design. Lighter-weight: no order is created, no `amount`/`currency` is sent, and the response is just a `sessionToken` valid for roughly 10 minutes.

**Request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "clientRequestId": "req-session-0001",
  "timeStamp": "20260702090000",
  "checksum": "<sha256 hex — see §1.3, no amount/currency>"
}
```

**Response**
```json
{
  "sessionToken": "7df876e6-9a2b-4fae-8ac0-85d70d2d48ce",
  "internalRequestId": 222584528,
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

### 3.2 `/getPaymentStatus`

Verifies a `/payment` outcome server-side, using the same `sessionToken`. Two hard constraints from Nuvei's docs:
- Only works **while the session that produced the sessionToken is still open** — once it expires, you get a "session expired" response and must fall back to `/getTransactionDetails` or the DMN.
- **Do not use for repeated polling** during payment processing — Nuvei may block your server's IP if you do. Use it for an on-demand re-check (e.g. a support agent looking up an order), not a retry loop.

**Request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "sessionToken": "7df876e6-9a2b-4fae-8ac0-85d70d2d48ce",
  "clientRequestId": "req-status-0001",
  "timeStamp": "20260702090500",
  "checksum": "<sha256 hex — no amount/currency, see §1.3>"
}
```

**Response**
```json
{
  "transactionId": "119004521",
  "transactionStatus": "APPROVED",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Note on source completeness:** Nuvei's docs confirm the constraints above and that the request is built from `sessionToken` plus the standard auth fields, but do not publish an exhaustive response field table for this endpoint. Fields beyond `transactionStatus`/`transactionId` (e.g. `paymentMethodErrorCode`/`paymentMethodErrorReason`) are inferred from the general response-handling reference (§6) and should be confirmed against your live Postman collection.

### 3.3 `/getTransactionDetails`

The durable lookup, keyed by `transactionId` rather than a session — use this once a session has expired, or for reconciliation/reporting rather than live-flow verification.

**Request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "transactionId": "119004521",
  "clientRequestId": "req-details-0001",
  "timeStamp": "20260702093000",
  "checksum": "<sha256 hex — no amount/currency, see §1.3>"
}
```

**Response**
```json
{
  "transactionId": "119004521",
  "transactionStatus": "APPROVED",
  "transactionType": "Sale",
  "authCode": "111570",
  "amount": "10.00",
  "currency": "EUR",
  "status": "SUCCESS",
  "errCode": 0,
  "reason": ""
}
```

**Note on source completeness:** Nuvei's REST 1.0 docs don't publish a dedicated `/getTransactionDetails` parameter/response table (their REST 2.0 API reference has an equivalent, differently-shaped endpoint at `/api/v2/main/docs/data/get-transaction-details/`). The request/response shape above follows this integration's consistent v1 conventions (same auth envelope, `transactionId`-keyed lookup) but has **not** been independently confirmed field-by-field against a v1-specific reference — verify against your Postman collection before relying on any field not already confirmed elsewhere in this document (`transactionId`, `transactionStatus`).

---

## 4. DMN (webhook) handling — shared across all seven APMs

Since every APM in this document is redirect-flow, the DMN is not optional — it is the only channel that confirms final status after the customer leaves your site.

**Checksum validation:**
```
digest = SHA256( merchantSecretKey + totalAmount + currency + responseTimeStamp + ppp_TransactionID + Status + productId )
assert digest == advanceResponseChecksum
```
("+" characters in field values must be replaced with spaces before concatenation.)

**Key fields:** `ppp_status`, `PPP_TransactionID`, `totalAmount`, `currency`, `Status`, `payment_method`, `clientUniqueId`/`clientRequestId` (for correlating back to your order).

**Status values to handle:** `APPROVED`, `DECLINED`, `PENDING` (Fawry in particular can sit in `PENDING` for an extended period given its cash-voucher settlement model).

**Idempotency:** Nuvei may deliver more than one DMN per transaction (e.g. an initial `PENDING` followed by a final `APPROVED`/`DECLINED`). Dedupe by `PPP_TransactionID`.

---

## 5. Post-payment financial operations: capture, void, refund

All three reference the original payment by `relatedTransactionId` (the `transactionId` returned from `/payment`) — never a subsequent operation's own transaction ID. Each produces its own new `transactionId` for the operation itself.

### 5.1 Applicability caveat — read this before wiring capture into an APM flow

**Capture (`/settleTransaction`) only applies when the original `/payment` was submitted as an Auth-only transaction.** Most of the seven APMs in this document settle in a single step (`transactionType: "Sale"`, implicit) — the APM provider debits the customer directly, and there is nothing left to capture afterward. Attempting to `/settleTransaction` against a Sale-type transaction will be rejected by Nuvei. Capture is relevant here only if your merchant account is configured for two-phase Auth+Settle on these payment methods specifically — confirm with Nuvei which of the seven (if any) support that mode. **Void and refund remain broadly applicable** regardless: void in the brief pre-settlement window, refund afterward.

### 5.2 `/settleTransaction` (capture)

**Required parameters:** `merchantId`, `merchantSiteId`, `relatedTransactionId` (original Auth transaction), `authCode` (from the original `/payment` response), `currency` (must match the original), `amount` (full or partial), `clientUniqueId`, `clientRequestId`.

**Checksum:** same formula as `/payment` (§1.3) — includes `amount`/`currency`.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "relatedTransactionId": "119004521",
  "authCode": "111570",
  "amount": "10.00",
  "currency": "EUR",
  "clientUniqueId": "capture-0001",
  "clientRequestId": "req-capture-0001",
  "timeStamp": "20260702094000",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "transactionId": "1110000000004320882",
  "transactionStatus": "APPROVED",
  "authCode": "111570",
  "transactionType": "Settle",
  "status": "SUCCESS",
  "errCode": 0
}
```

**Notes:**
- Multiple partial `/settleTransaction` requests are allowed as long as they sum to no more than the original authorized amount; add `totalSettleCount` to every related request if you're splitting a settlement into a known number of parts.
- The settlement window is time-boxed (Nuvei's docs describe up to 7 days, bank/config-dependent) — after that, the authorization and hold expire automatically and capture is no longer possible.
- Multi-settle requires a TSYS acquirer and a US merchant ID; Amex is excluded from that specific capability.

### 5.3 `/voidTransaction`

Cancels a transaction in the short window between submission and settlement transmission — releases the hold without completing payment.

**Required parameters (assumed — not individually confirmed in Nuvei's public docs):** `merchantId`, `merchantSiteId`, `relatedTransactionId`, `currency`, `clientUniqueId`, `clientRequestId`. No `amount` — a void cancels the transaction in full.

**Checksum:** the `/getSessionToken`-style formula (§1.3), i.e. no `amount` — assumed, not confirmed; verify before production.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "relatedTransactionId": "119004521",
  "currency": "EUR",
  "clientUniqueId": "void-0001",
  "clientRequestId": "req-void-0001",
  "timeStamp": "20260702094500",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "transactionId": "1110000000004320999",
  "transactionStatus": "APPROVED",
  "transactionType": "Void",
  "status": "SUCCESS",
  "errCode": 0
}
```

**Note on source completeness:** Nuvei's docs describe the *purpose* of `/voidTransaction` clearly but do not publish a full parameter table, checksum formula, or example payloads for it. The shape above is inferred from the consistent pattern across every other confirmed v1 endpoint in this document — treat it as a starting point to validate against your Postman collection, not a confirmed spec.

### 5.4 `/refundTransaction`

Refunds a transaction Nuvei has already settled. This is the most broadly applicable post-payment operation for the seven APMs in this document, since all of them are (or typically are) single-step Sale transactions.

**Required parameters:** `merchantId`, `merchantSiteId`, `clientUniqueId`, `relatedTransactionId` (the original payment's `transactionId`), `currency` (must match original), `amount`.

**Checksum:** same formula as `/payment` (§1.3) — includes `amount`/`currency`.

**Sample request**
```json
{
  "merchantId": "{{merchantId}}",
  "merchantSiteId": "{{merchantSiteId}}",
  "relatedTransactionId": "119004521",
  "amount": "10.00",
  "currency": "EUR",
  "clientUniqueId": "refund-0001",
  "clientRequestId": "req-refund-0001",
  "timeStamp": "20260702100000",
  "checksum": "<sha256 hex>"
}
```

**Sample response**
```json
{
  "transactionId": "1110000000004321050",
  "transactionStatus": "APPROVED",
  "transactionType": "Credit",
  "authCode": "778812",
  "status": "SUCCESS",
  "errCode": 0
}
```

**Notes:**
- `amount` plus the sum of all prior partial refunds against the same transaction must not exceed the original sale amount — Nuvei rejects over-refunding.
- Wait at least 60 seconds before treating a `/refundTransaction` call as timed out; do not blindly retry, since a duplicate refund request within that window risks a double-refund if the first request actually succeeded server-side but the response was lost in transit.
- For transactions not originally settled by Nuvei, an "unreferenced refund" is possible using full card details, a UPO token, or a network token instead of `relatedTransactionId` — not applicable to the APM flows in this document, which are always Nuvei-settled.

---

## 6. Error codes reference

### 4.1 Request-validation errors (`errCode` / `reason`) — returned synchronously in stage 1

| errCode | Reason |
|---|---|
| 1000 | General Error |
| 1001 | Invalid checksum |
| 1004 | Missing or invalid CardData |
| 1007 | Invalid name on card |
| 1010 | Invalid user token |
| 1013 | Invalid merchant ID |
| 1019 | Validation Error |
| 1021 | Invalid timestamp |
| 1040 | Invalid or missing amount |
| 1057 | Invalid order ID |
| 1062 | Invalid CVV |
| 1067 | Invalid or missing transaction type |
| 1069 | Session expired |
| 1070 | Currency not supported by merchant settings |
| 1076 | Unsupported payment method |
| 1081 | IP Address is blocked |
| 1088 | Invalid clientRequestId |
| 9064 | 3D Authentication failure |
| 9065 | Currency not supported by payment method |
| 9072 | Payment is still in progress |
| 9075 | 3D Secure authentication failed, payment not allowed |

*(This is the subset most relevant to APM/redirect flows — Nuvei's full response-handling reference has additional card/3DS-specific codes not reproduced here since they don't apply to these seven APMs.)*

### 4.2 Gateway-level status (`transactionStatus` / `gwErrorCode` / `gwExtendedErrorCode`) — stage 2

| gwErrorCode | gwExtendedErrorCode | Resulting transactionStatus |
|---|---|---|
| 0 | 0 | APPROVED |
| -1 | 0 | DECLINED |
| -1100 | > 0 | ERROR (filter/risk error) |

Common `gwExtendedErrorCode` values (mostly card-specific; included for completeness in mixed card+APM checkouts): `1001` Invalid Expiration Date, `1101` Invalid Card Number, `1104` Invalid CVV2, `1114` Blacklisted card number, `1155` 3D-related transaction missing/incorrect, `1220` Expired Token, `1268` Token inactive, `1276` Authentication timeout.

Common `gwErrorReason` strings when `gwErrorCode = -1` (DECLINED): `"Account Closed"`, `"Activity limit exceeded"`, `"APM authentication error"`, `"Call issuer"`, `"Do not honor"`, `"Duplicate transaction"`, `"Insufficient funds"`, `"Suspected fraud"`, `"Timeout/Retry"`, `"Transaction not permitted to cardholder"`.

### 4.3 Processing stages — where to look for the failure reason

| Stage | Fields | When populated |
|---|---|---|
| 1. Request validation | `errCode`, `reason` | Malformed request, bad checksum, unknown paymentMethod — fails before Nuvei even contacts the APM provider |
| 2. Gateway/bank response | `transactionStatus`, `gwErrorCode`, `gwErrorReason`, `gwExtendedErrorCode` | Nuvei/acquirer-level outcome |
| 3. APM-specific | `paymentMethodErrorCode`, `paymentMethodErrorReason` | Returned by the APM provider itself (e.g. Zip declined the installment plan, GrabPay wallet had insufficient balance) — check these fields specifically for APM transactions, since stage 2 fields may just say generic DECLINED |

### 4.4 Verification guidance (from Nuvei docs)

> "Responses to Web SDK and Simply Connect requests are not verified" — always verify server-side via a `/getPaymentStatus` call or via the DMN webhook rather than trusting the client-side redirect return.

---

## 7. Open items to confirm with Nuvei before production

1. **Fawry** — confirm whether a dedicated `paymentMethod` code exists for your merchant account distinct from the bundled `apmgw_Local_payments_Africa`, and how the cash-voucher reference number is surfaced in the response.
2. **Twint** — no standalone field-level documentation page was found; confirm no additional mandatory fields apply beyond the common set.
3. **GrabPay** — confirm which country-specific `paymentMethod` variants (beyond `apmgw_Grabpay_Malaysia`) are enabled on your account, and their respective currencies.
4. **`/payment` checksum field order** — this design assumes it matches the confirmed `/openOrder` order (`merchantId + merchantSiteId + clientRequestId + amount + currency + timeStamp + secretKey`); verify against your live Postman collection.
5. **`paymentMethodErrorCode`/`paymentMethodErrorReason` catalog** — Nuvei's public docs describe these fields exist but don't publish a full APM-specific code table; capture and log raw values in production to build an internal reference as real transactions occur.
6. **`/getTransactionDetails` and `/voidTransaction` field tables** — neither has a published REST 1.0 parameter/response reference; both are implemented here by pattern-matching the conventions confirmed elsewhere (§3.3, §5.3) and need direct verification.
7. **Auth-vs-Sale transaction type per APM** — confirm with Nuvei which (if any) of the seven APMs in this document support two-phase Auth+Settle, since that determines whether `/settleTransaction` (capture) is usable at all for a given APM (§5.1).
8. **`/voidTransaction` and `/getPaymentStatus`/`/getTransactionDetails` checksum formula** — this design assumes the no-amount ("session-style") formula for all three; confirmed only for `/getSessionToken` itself.
