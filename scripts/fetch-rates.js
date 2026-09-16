// scripts/fetch-rates.js
//
// Fetches the latest USD exchange rates from exchangerate-api.com (v6, paid/free-tier
// with API key — NOT the open-access endpoints), plus NAV prices for a small whitelist of
// Vietnamese fund certificates from fmarket.vn's internal (unofficial, undocumented)
// product API, and writes rates.json at the repo root, preserving the existing flat schema:
//
// {
//   "date": "YYYY-MM-DD",
//   "base": "USD",
//   "rates": { "USD": 1, "AED": 3.67, ..., "VFF": 0.9654, ... }
// }
//
// Fund rates are expressed in the same "units of code per 1 base (USD)" convention as
// every other entry, by pivoting the fund's VND-denominated NAV through the freshly
// fetched VND fiat rate: rate[fundCode] = rate["VND"] / navInVnd.
//
// Requirements this script enforces:
// - API key is read from process.env.EXCHANGERATE_API_KEY, never hardcoded, never logged.
// - The "date" field is always refreshed to today's UTC date on every successful run,
//   so there's a fresh commit every day even if the underlying rates didn't change
//   (keeps the scheduled workflow from being auto-disabled after 60 days of no activity).
// - Fiat rates are load-bearing: on any failure fetching/parsing them, the script logs a
//   clear error and exits non-zero WITHOUT touching the existing rates.json, so the app
//   keeps serving yesterday's (still-valid) cached data.
// - Fund rates are best-effort and isolated: fmarket.vn's API is an unofficial, undocumented
//   endpoint the fmarket.vn frontend happens to call, with no SLA. If fetching/parsing it
//   fails (network error, schema change, a whitelisted fund missing from the response), the
//   script logs a warning, falls back to that fund's rate from the existing rates.json (if
//   any), and still completes the run using the fresh fiat rates. A fund fetch failure never
//   fails the whole job.

const fs = require("fs");
const path = require("path");

const RATES_FILE = path.join(__dirname, "..", "rates.json");

// Vietnamese fund certificates ("chứng chỉ quỹ") to include, keyed by fmarket.vn's short
// name — the same code shown in the fund's URL (fmarket.vn/quy/<code>). Add more codes here
// as support is rolled out for additional funds. Note: a fund's short name can differ from
// its internal product `code` (e.g. "DCDS" is internally "VFMVF1") — fetching by short name
// via FMARKET_PRODUCT_URL_PREFIX sidesteps that entirely, no need to know the internal code.
const FUND_CODES = ["VFF", "VESAF", "VIBF", "VLBF", "DCDS", "DCBF", "DCIP"];

const FMARKET_PRODUCT_URL_PREFIX = "https://api.fmarket.vn/home/product/";
const FMARKET_TIMEOUT_MS = 15000;
// Identify as a real browser UA — this is the same request fmarket.vn's own web frontend
// makes; an unusual/absent UA is an easy, gratuitous signal for anti-bot filtering.
const FMARKET_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function redactApiKeyFromString(str, apiKey) {
  if (!apiKey) return str;
  return str.split(apiKey).join("***REDACTED***");
}

function readExistingRates() {
  try {
    const raw = fs.readFileSync(RATES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.rates && typeof parsed.rates === "object") {
      return parsed.rates;
    }
  } catch (_) {
    // No existing file, or it's malformed — treat as "no prior fund rates available".
  }
  return {};
}

async function fetchFiatRates(apiKey) {
  const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    // Never include the raw error object as-is if it could echo the URL (which contains
    // the key) — redact defensively before logging.
    throw new Error(
      "Network request to exchangerate-api.com failed: " +
        redactApiKeyFromString(String(err && err.message), apiKey)
    );
  }

  if (!response.ok) {
    let errorType = null;
    try {
      const body = await response.json();
      if (body && body["error-type"]) {
        errorType = body["error-type"];
      }
    } catch (_) {
      // ignore — body wasn't JSON or couldn't be parsed
    }
    throw new Error(
      `exchangerate-api.com responded with HTTP ${response.status} ${response.statusText}.` +
        (errorType ? ` API error-type: ${errorType}` : "")
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error("Failed to parse exchangerate-api.com response as JSON.");
  }

  if (
    !data ||
    data.result !== "success" ||
    data.base_code !== "USD" ||
    !data.conversion_rates ||
    typeof data.conversion_rates !== "object" ||
    Object.keys(data.conversion_rates).length === 0
  ) {
    throw new Error(
      "exchangerate-api.com response missing expected fields (result/base_code/conversion_rates)." +
        " Raw result field: " +
        JSON.stringify(data && data.result)
    );
  }

  return data.conversion_rates;
}

// Fetches one fund's NAV by short name. Never throws — returns { nav } on success or
// { error } on any failure (network, non-OK HTTP, malformed JSON, missing/invalid nav).
async function fetchFundNav(code) {
  let response;
  try {
    response = await fetch(FMARKET_PRODUCT_URL_PREFIX + encodeURIComponent(code), {
      headers: { "User-Agent": FMARKET_USER_AGENT },
      signal: AbortSignal.timeout(FMARKET_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `request failed: ${String(err && err.message)}` };
  }

  if (!response.ok) {
    return { error: `HTTP ${response.status} ${response.statusText}` };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return { error: "failed to parse response as JSON" };
  }

  const nav = body && body.data && body.data.nav;
  if (typeof nav !== "number" || !(nav > 0)) {
    return { error: "response missing a valid data.nav" };
  }
  return { nav };
}

// Best-effort: fetches NAV for each whitelisted fund code and pivots it into a "units per 1
// USD" rate via the fresh VND fiat rate. Returns { fundRates, warnings }. Never throws — each
// fund is fetched independently, so one fund's failure never affects the others, and any
// failure is captured as a warning with that fund's entry simply omitted from fundRates
// (caller falls back to the previous value, if any).
async function fetchFundRates(fiatRates) {
  const warnings = [];
  const fundRates = {};

  const vndRate = fiatRates["VND"];
  if (typeof vndRate !== "number" || !(vndRate > 0)) {
    warnings.push(
      "Cannot compute fund rates: no valid VND rate in this run's fiat rates."
    );
    return { fundRates, warnings };
  }

  for (const code of FUND_CODES) {
    const result = await fetchFundNav(code);
    if (result.error) {
      warnings.push(`Fund "${code}": ${result.error}.`);
      continue;
    }
    // rate[code] = units of `code` per 1 USD, pivoted through VND:
    // 1 USD = vndRate VND; 1 unit of `code` = nav VND  =>  1 USD = (vndRate / nav) units.
    // Deliberately not rounded — fiat rates in this same file keep full source precision too
    // (e.g. "VND": 25903.0397), and rounding this to only 6dp previously introduced a ~5.8e-7
    // relative error that, multiplied through a large VND balance, showed up as a
    // ~200 VND-per-few-hundred-million discrepancy against fmarket's own displayed total.
    fundRates[code] = vndRate / result.nav;
  }

  return { fundRates, warnings };
}

async function main() {
  const apiKey = process.env.EXCHANGERATE_API_KEY;

  if (!apiKey) {
    console.error(
      "ERROR: EXCHANGERATE_API_KEY environment variable is not set. " +
        "Refusing to run. rates.json left untouched."
    );
    process.exitCode = 1;
    return;
  }

  let fiatRates;
  try {
    fiatRates = await fetchFiatRates(apiKey);
  } catch (err) {
    console.error(`ERROR: ${err.message} rates.json left untouched.`);
    process.exitCode = 1;
    return;
  }

  const existingRates = readExistingRates();
  const { fundRates, warnings } = await fetchFundRates(fiatRates);

  for (const warning of warnings) {
    console.warn(`WARN: ${warning}`);
  }

  const finalFundRates = {};
  for (const code of FUND_CODES) {
    if (Object.prototype.hasOwnProperty.call(fundRates, code)) {
      finalFundRates[code] = fundRates[code];
    } else if (Object.prototype.hasOwnProperty.call(existingRates, code)) {
      finalFundRates[code] = existingRates[code];
      console.warn(`WARN: Using stale cached rate for "${code}" from previous rates.json.`);
    } else {
      console.warn(`WARN: No rate available for "${code}" (fresh fetch failed, no prior value). Omitting.`);
    }
  }

  const output = {
    date: todayUtcDateString(),
    base: "USD",
    rates: { ...fiatRates, ...finalFundRates },
  };

  try {
    fs.writeFileSync(RATES_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error("ERROR: Failed to write rates.json:", err.message);
    process.exitCode = 1;
    return;
  }

  const currencyCount = Object.keys(output.rates).length;
  console.log(
    `OK: rates.json updated for ${output.date} with ${currencyCount} entries ` +
      `(${Object.keys(finalFundRates).length} fund(s): ${Object.keys(finalFundRates).join(", ") || "none"}).`
  );
}

main();
