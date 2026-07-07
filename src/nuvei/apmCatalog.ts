export interface ApmField {
  name: string;
  label: string;
  required: boolean;
  placeholder?: string;
  pattern?: string;
}

export interface ApmDefinition {
  code: string;
  label: string;
  description: string;
  flowType: "direct" | "redirect";
  country: string;
  currency: string;
  fields: ApmField[];
  needsPhone?: boolean;
  needsDeviceType?: boolean;
  notes?: string;
}

// Codes and required fields below are confirmed against Nuvei's published APM
// docs as of this integration. Nuvei publishes 100+ APMs in total — this is a
// representative subset spanning direct/redirect flows and regions, not the
// full catalog. Verify any APM not listed here against docs.nuvei.com before adding it.
export const APM_CATALOG: ApmDefinition[] = [
  {
    code: "apmgw_BLIK",
    label: "BLIK",
    description:
      "Polish direct-flow APM. The customer enters a 6-digit code generated in their banking app directly on your page, then confirms the payment inside the app. No redirect hop.",
    flowType: "direct",
    country: "PL",
    currency: "PLN",
    fields: [
      { name: "blik_code", label: "BLIK code", required: true, placeholder: "777654", pattern: "^\\d{6}$" },
    ],
  },
  {
    code: "apmgw_iDeal",
    label: "iDEAL",
    description:
      "Dutch bank redirect APM. The customer is redirected to their bank to authenticate and confirm payment, then returned to your site.",
    flowType: "redirect",
    country: "NL",
    currency: "EUR",
    fields: [{ name: "BIC", label: "Bank BIC", required: false, placeholder: "INGBNL2A" }],
  },
  {
    code: "apmgw_P24",
    label: "Przelewy24",
    description: "Polish bank redirect APM. Customer selects their bank and authenticates on Przelewy24's page.",
    flowType: "redirect",
    country: "PL",
    currency: "PLN",
    fields: [],
  },
  {
    code: "apmgw_MoneyBookers",
    label: "Skrill",
    description: "Global e-wallet redirect APM (formerly Moneybookers). Customer logs into their Skrill account to confirm payment.",
    flowType: "redirect",
    country: "GB",
    currency: "EUR",
    fields: [{ name: "account_id", label: "Skrill account email", required: true, placeholder: "customer@example.com" }],
  },
  {
    code: "apmgw_expresscheckout",
    label: "PayPal",
    description: "Global e-wallet redirect APM. Customer logs into PayPal to approve the payment.",
    flowType: "redirect",
    country: "US",
    currency: "USD",
    fields: [],
  },
  {
    code: "apmgw_ACH",
    label: "ACH",
    description:
      "US direct bank-debit APM. Customer enters bank account and routing numbers directly; transaction settles asynchronously over several days (PENDING → APPROVED via DMN).",
    flowType: "direct",
    country: "US",
    currency: "USD",
    fields: [
      { name: "AccountNumber", label: "Bank account number", required: true, placeholder: "000123456789" },
      { name: "RoutingNumber", label: "Routing number", required: true, placeholder: "021000021" },
      { name: "SECCode", label: "SEC code", required: true, placeholder: "WEB" },
    ],
  },
  {
    code: "apmgw_PIX",
    label: "PIX",
    description: "Brazilian instant-payment APM. Customer scans a QR code or is redirected to confirm via their bank app.",
    flowType: "redirect",
    country: "BR",
    currency: "BRL",
    fields: [{ name: "personal_id", label: "CPF (personal ID)", required: true, placeholder: "12345678909" }],
  },
  {
    code: "apmgw_Swish",
    label: "Swish",
    description: "Swedish mobile bank-transfer APM. Customer confirms the payment in the Swish app on their phone.",
    flowType: "redirect",
    country: "SE",
    currency: "SEK",
    fields: [{ name: "IBP_national_id", label: "Swedish national ID", required: true, placeholder: "199001011234" }],
  },
  {
    code: "apmgw_zip",
    label: "Zip",
    description:
      "Buy Now Pay Later redirect APM. Customer authenticates on Zip's hosted page and selects an installment plan.",
    flowType: "redirect",
    country: "AU",
    currency: "AUD",
    fields: [],
  },
  {
    code: "apmgw_TWINT",
    label: "Twint",
    description: "Swiss mobile/QR wallet redirect APM. Customer confirms the payment in the Twint app.",
    flowType: "redirect",
    country: "CH",
    currency: "CHF",
    fields: [],
    notes: "No standalone Nuvei doc page — confirmed via the consolidated APM parameter reference only.",
  },
  {
    code: "apmgw_MobilePay",
    label: "MobilePay",
    description:
      "Danish/Finnish mobile wallet redirect APM. deviceType determines whether the customer gets an app deep-link or a web/QR redirect.",
    flowType: "redirect",
    country: "DK",
    currency: "DKK",
    fields: [],
    needsPhone: true,
    needsDeviceType: true,
  },
  {
    code: "apmgw_Local_payments_Africa",
    label: "Fawry",
    description:
      "Egyptian cash-voucher APM (bundled under Nuvei's Local Payments Africa method). Nuvei generates a reference number the customer pays via the Fawry app or at a physical outlet — settlement is asynchronous.",
    flowType: "redirect",
    country: "EG",
    currency: "EGP",
    fields: [],
    needsPhone: true,
    notes: "Nuvei does not publish an isolated Fawry paymentMethod code — confirm with your account manager whether one exists for your merchant account.",
  },
  {
    code: "apmgw_LINE_Pay",
    label: "LINE Pay",
    description: "Japanese/Taiwanese e-wallet redirect APM embedded in the LINE app.",
    flowType: "redirect",
    country: "JP",
    currency: "JPY",
    fields: [],
  },
  {
    code: "apmgw_PayPay",
    label: "PayPay",
    description: "Japanese QR/e-wallet redirect APM. Mobile customers open the PayPay app; desktop customers scan a QR code.",
    flowType: "redirect",
    country: "JP",
    currency: "JPY",
    fields: [],
  },
  {
    code: "apmgw_Grabpay_Malaysia",
    label: "GrabPay (Malaysia)",
    description: "Southeast Asian e-wallet redirect APM embedded in the Grab app.",
    flowType: "redirect",
    country: "MY",
    currency: "MYR",
    fields: [],
    notes: "Malaysia-specific code variant — confirm other country variants (e.g. apmgw_Grabpay) with Nuvei if you need broader SEA coverage.",
  },
];

export function findApm(code: string): ApmDefinition | undefined {
  return APM_CATALOG.find((apm) => apm.code === code);
}
