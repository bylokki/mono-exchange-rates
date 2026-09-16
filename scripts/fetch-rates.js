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

// Vietnamese fund certificates ("chứng chỉ quỹ") to include, keyed by fmarket.vn's
// `code` field. Add more codes here as support is rolled out for additional funds.
const FUND_CODES = ["VFF"];

const FMARKET_PRODUCTS_URL = "https://api.fmarket.vn/res/products/filter";
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

// Best-effort: fetches NAV for the whitelisted fund codes and pivots each into a
// "units per 1 USD" rate via the fresh VND fiat rate. Returns { fundRates, warnings }.
// Never throws — any failure is captured as a warning and that fund's entry is simply
// omitted from fundRates (caller falls back to the previous value, if any).
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

  let response;
  try {
    response = await fetch(FMARKET_PRODUCTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": FMARKET_USER_AGENT,
      },
      body: JSON.stringify({
        types: ["NEW_FUND", "TRADING_FUND"],
        issuerIds: [],
        sortOrder: "DESC",
        sortField: "navTo6Months",
        page: 1,
        pageSize: 200,
        isIpo: false,
        fundAssetTypes: [],
        bondRemainPeriods: [],
        searchField: null,
        searchValue: null,
        isBuyByReward: false,
      }),
      signal: AbortSignal.timeout(FMARKET_TIMEOUT_MS),
    });
  } catch (err) {
    warnings.push(`fmarket.vn request failed: ${String(err && err.message)}`);
    return { fundRates, warnings };
  }

  if (!response.ok) {
    warnings.push(
      `fmarket.vn responded with HTTP ${response.status} ${response.statusText}.`
    );
    return { fundRates, warnings };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    warnings.push("Failed to parse fmarket.vn response as JSON.");
    return { fundRates, warnings };
  }

  const rows = body && body.data && Array.isArray(body.data.rows) ? body.data.rows : null;
  if (!rows) {
    warnings.push("fmarket.vn response missing expected data.rows array.");
    return { fundRates, warnings };
  }

  const rowByCode = new Map(rows.map((row) => [row && row.code, row]));

  for (const code of FUND_CODES) {
    const row = rowByCode.get(code);
    const nav = row && row.nav;
    if (typeof nav !== "number" || !(nav > 0)) {
      warnings.push(`Fund "${code}" not found (or has no valid NAV) in fmarket.vn response.`);
      continue;
    }
    // rate[code] = units of `code` per 1 USD, pivoted through VND:
    // 1 USD = vndRate VND; 1 unit of `code` = nav VND  =>  1 USD = (vndRate / nav) units.
    fundRates[code] = Math.round((vndRate / nav) * 1e6) / 1e6;
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
