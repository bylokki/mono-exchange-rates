// scripts/fetch-rates.js
//
// Fetches the latest USD exchange rates from exchangerate-api.com (v6, paid/free-tier
// with API key — NOT the open-access endpoints) and writes rates.json at the repo root,
// preserving the existing schema:
//
// {
//   "date": "YYYY-MM-DD",
//   "base": "USD",
//   "rates": { "USD": 1, "AED": 3.67, ... }
// }
//
// Requirements this script enforces:
// - API key is read from process.env.EXCHANGERATE_API_KEY, never hardcoded, never logged.
// - The "date" field is always refreshed to today's UTC date on every successful run,
//   so there's a fresh commit every day even if the underlying rates didn't change
//   (keeps the scheduled workflow from being auto-disabled after 60 days of no activity).
// - On any failure (network error, non-OK API response, malformed payload), the script
//   logs a clear error and exits non-zero WITHOUT touching the existing rates.json, so the
//   app keeps serving yesterday's (still-valid) cached data.

const fs = require("fs");
const path = require("path");

const RATES_FILE = path.join(__dirname, "..", "rates.json");

function todayUtcDateString() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function redactApiKeyFromString(str, apiKey) {
  if (!apiKey) return str;
  return str.split(apiKey).join("***REDACTED***");
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

  const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    // Never include the raw error object as-is if it could echo the URL (which contains
    // the key) — redact defensively before logging.
    console.error(
      "ERROR: Network request to exchangerate-api.com failed:",
      redactApiKeyFromString(String(err && err.message), apiKey)
    );
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(
      `ERROR: exchangerate-api.com responded with HTTP ${response.status} ${response.statusText}. ` +
        "rates.json left untouched."
    );
    // Try to surface the API's own error message (e.g. invalid key, quota exceeded)
    // without ever printing the request URL or key.
    try {
      const body = await response.json();
      if (body && body["error-type"]) {
        console.error(`API error-type: ${body["error-type"]}`);
      }
    } catch (_) {
      // ignore — body wasn't JSON or couldn't be parsed
    }
    process.exitCode = 1;
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error("ERROR: Failed to parse API response as JSON. rates.json left untouched.");
    process.exitCode = 1;
    return;
  }

  if (
    !data ||
    data.result !== "success" ||
    data.base_code !== "USD" ||
    !data.conversion_rates ||
    typeof data.conversion_rates !== "object" ||
    Object.keys(data.conversion_rates).length === 0
  ) {
    console.error(
      "ERROR: API response missing expected fields (result/base_code/conversion_rates). " +
        "rates.json left untouched. Raw result field: " +
        JSON.stringify(data && data.result)
    );
    process.exitCode = 1;
    return;
  }

  const output = {
    date: todayUtcDateString(),
    base: "USD",
    rates: data.conversion_rates,
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
    `OK: rates.json updated for ${output.date} with ${currencyCount} currencies.`
  );
}

main();
