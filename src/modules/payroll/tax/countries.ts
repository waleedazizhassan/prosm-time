// HR suite feature 4: the countries by ISO code - the name in the reader's language comes from the
// browser (Intl.DisplayNames), the flag from the code. Only the code is stored.

export const COUNTRY_CODES = (
  "AE AF AL AM AO AR AT AU AZ BA BD BE BF BG BH BI BJ BN BO BR BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CY CZ DE DJ DK DO DZ EC EE EG ER ES ET FI FJ FR GA GB GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KR KW KZ LA LB LK LR LS LT LU LV LY MA MD ME MG MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PS PT PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SN SO SR SS SV SY SZ TD TG TH TJ TL TM TN TR TT TW TZ UA UG US UY UZ VE VN YE ZA ZM ZW"
).split(" ");

// the usual currency of a country (a suggestion the user can change)
const CURRENCY: Record<string, string> = {
  EG: "EGP", SA: "SAR", AE: "AED", KW: "KWD", QA: "QAR", BH: "BHD", OM: "OMR", JO: "JOD", LB: "LBP", IQ: "IQD", SY: "SYP", PS: "ILS", YE: "YER",
  LY: "LYD", TN: "TND", DZ: "DZD", MA: "MAD", SD: "SDG", MR: "MRU", SO: "SOS", DJ: "DJF", KM: "KMF", TR: "TRY", US: "USD", GB: "GBP", CA: "CAD",
  AU: "AUD", IN: "INR", PK: "PKR", BD: "BDT", NG: "NGN", KE: "KES", ZA: "ZAR", CN: "CNY", JP: "JPY", RU: "RUB", BR: "BRL", MX: "MXN", CH: "CHF",
  SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", MY: "MYR", ID: "IDR", PH: "PHP", TH: "THB", VN: "VND", SG: "SGD", NZ: "NZD",
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", PT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", CY: "EUR", MT: "EUR",
  LU: "EUR", SK: "EUR", SI: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", HR: "EUR",
};

export const suggestedCurrency = (code: string) => CURRENCY[code] ?? "USD";

export function flag(code: string): string {
  return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

export function countryName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "🇯🇴 الأردن — Jordan": the reader's language, and English beside it when different */
export function countryLabel(code: string, language: string): string {
  const local = countryName(code, language);
  const english = countryName(code, "en");
  return `${flag(code)} ${local}${english !== local ? ` — ${english}` : ""}`;
}
