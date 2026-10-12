const requestTimeoutMs = 8000;
const cacheDurationMs = 60_000;
const knownRegions = ["Central", "East", "North", "South", "West"];
const monthNames = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const numberWords = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

let cachedLedger;
let cachedAt = 0;
let loadingLedger;

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function readJson(response, label) {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function loadLedger() {
  if (cachedLedger && Date.now() - cachedAt < cacheDurationMs) {
    return cachedLedger;
  }
  if (loadingLedger) {
    return loadingLedger;
  }

  loadingLedger = (async () => {
    const discoveryUrl = process.env.LEDGER_DISCOVERY_URL;
    if (!discoveryUrl) {
      throw new Error("LEDGER_DISCOVERY_URL is not configured");
    }

    const discoveryResponse = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const discovery = await readJson(discoveryResponse, "Ledger discovery");
    if (!discovery.links?.export || !discovery.links?.rates) {
      throw new Error("Ledger discovery response is missing export or rates links");
    }

    const [exportResponse, ratesResponse] = await Promise.all([
      fetch(discovery.links.export, { signal: AbortSignal.timeout(requestTimeoutMs) }),
      fetch(discovery.links.rates, { signal: AbortSignal.timeout(requestTimeoutMs) }),
    ]);
    if (!exportResponse.ok) {
      throw new Error(`Ledger export request failed with HTTP ${exportResponse.status}`);
    }
    const rates = await readJson(ratesResponse, "Currency rates");
    const usdPerUnit = rates.usd_per_unit;
    if (!usdPerUnit || typeof usdPerUnit.USD !== "number") {
      throw new Error("Currency rates response is missing USD conversion rates");
    }

    const exportText = await exportResponse.text();
    const currentOrders = new Map();
    for (const line of exportText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let order;
      try {
        order = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ledger export: ${error.message}`);
      }
      if (
        typeof order.id !== "string" ||
        typeof order.updated_at !== "string" ||
        typeof order.created_at !== "string" ||
        typeof order.amount !== "number" ||
        typeof order.qty !== "number" ||
        typeof order.currency !== "string" ||
        typeof order.status !== "string"
      ) {
        throw new Error("Ledger export contains a row with missing or invalid fields");
      }
      const prior = currentOrders.get(order.id);
      if (!prior || Date.parse(order.updated_at) > Date.parse(prior.updated_at)) {
        currentOrders.set(order.id, order);
      }
    }

    if (currentOrders.size === 0) {
      throw new Error("Ledger export contained no orders");
    }

    cachedLedger = {
      orders: [...currentOrders.values()],
      usdPerUnit,
    };
    cachedAt = Date.now();
    return cachedLedger;
  })();

  try {
    return await loadingLedger;
  } finally {
    loadingLedger = undefined;
  }
}

function businessDate(order) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(order.created_at));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function extractFilters(question, orders) {
  const lower = question.toLowerCase();
  const filters = {};

  const region = knownRegions.find((name) => new RegExp(`\\b${name.toLowerCase()}\\b`, "i").test(question));
  if (region) filters.region = region;

  const products = [...new Set(orders.map((order) => order.product).filter(Boolean))];
  const product = products.find((name) => lower.includes(name.toLowerCase()));
  if (product) filters.product = product;

  const customer = question.match(/\bC\d{4}\b/i);
  if (customer) filters.customer = customer[0].toUpperCase();

  const explicitDate = question.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (explicitDate) {
    filters.startDate = `${explicitDate[1]}-${explicitDate[2].padStart(2, "0")}-${explicitDate[3].padStart(2, "0")}`;
    filters.endDate = filters.startDate;
  } else {
    const namedMonth = monthNames.findIndex((name, index) => {
      const abbreviated = name.slice(0, 3);
      return new RegExp(`\\b(?:${name}|${abbreviated})\\b`, "i").test(question) && index >= 0;
    });
    if (namedMonth !== -1) {
      const month = String(namedMonth + 1).padStart(2, "0");
      const year = question.match(/\b20\d{2}\b/)?.[0];
      if (year) {
        filters.startDate = `${year}-${month}-01`;
        filters.endDate = `${year}-${month}-${new Date(Number(year), namedMonth + 1, 0).getDate()}`;
      } else {
        filters.month = month;
      }
    }

    const quarter = question.match(/\bq([1-4])\s*(20\d{2})?\b/i)
      ?? question.match(/\b(?:first|second|third|fourth)\s+quarter(?:\s+of)?\s*(20\d{2})?\b/i);
    if (quarter) {
      const quarterNumber = /^\d$/.test(quarter[1])
        ? Number(quarter[1])
        : ({ first: 1, second: 2, third: 3, fourth: 4 })[quarter[0].toLowerCase().split(/\s+/)[0]];
      const year = quarter[2] ?? quarter[1]?.match(/20\d{2}/)?.[0];
      const inferredYear = year ?? question.match(/\b20\d{2}\b/)?.[0];
      if (inferredYear) {
        const startMonth = (quarterNumber - 1) * 3 + 1;
        filters.startDate = `${inferredYear}-${String(startMonth).padStart(2, "0")}-01`;
        const endMonth = startMonth + 2;
        filters.endDate = `${inferredYear}-${String(endMonth).padStart(2, "0")}-${new Date(Number(inferredYear), endMonth, 0).getDate()}`;
        delete filters.month;
      }
    }

    const yearOnly = question.match(/\b(?:in|during|for|of)\s+(20\d{2})\b/);
    if (yearOnly && !filters.startDate) {
      filters.startDate = `${yearOnly[1]}-01-01`;
      filters.endDate = `${yearOnly[1]}-12-31`;
    }
  }

  return filters;
}

function filterOrders(orders, filters) {
  return orders.filter((order) => {
    if (filters.region && order.region.toLowerCase() !== filters.region.toLowerCase()) return false;
    if (filters.product && order.product.toLowerCase() !== filters.product.toLowerCase()) return false;
    if (filters.customer && order.customer.toUpperCase() !== filters.customer) return false;
    const date = businessDate(order);
    if (filters.startDate && date < filters.startDate) return false;
    if (filters.endDate && date > filters.endDate) return false;
    if (filters.month && date.slice(5, 7) !== filters.month) return false;
    return true;
  });
}

function targetCurrency(question) {
  const match = question.match(/\b(?:in|to|as)\s+(USD|EUR|INR)\b/i)
    ?? question.match(/\b(USD|EUR|INR)\b/i);
  return match?.[1]?.toUpperCase() ?? "USD";
}

function amountInCurrency(order, currency, rates) {
  const sourceRate = rates[order.currency];
  const targetRate = rates[currency];
  if (typeof sourceRate !== "number" || typeof targetRate !== "number") {
    throw new Error(`Missing exchange rate for ${order.currency} or ${currency}`);
  }
  return order.amount * sourceRate / targetRate;
}

function extractLimit(question) {
  const match = question.match(/\btop\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (!match) return 5;
  return Math.min(10, Number(match[1]) || numberWords[match[1].toLowerCase()]);
}

function countMode(question) {
  return /\b(?:how many|number of|count of|count|quantity of|units? sold)\b/i.test(question)
    && !/\b(?:revenue|sales|spend|spent|refund amount|amount refunded|value|average|avg|mean|worth|dollars?|USD|EUR|INR)\b/i.test(question)
    || /\b(?:most|fewest|least|top|highest)\b/i.test(question)
      && /\b(?:orders?|transactions?)\b/i.test(question)
      && !/\b(?:revenue|sales|spend|spent|refund amount|amount refunded|value|average|avg|mean|worth|dollars?|USD|EUR|INR)\b/i.test(question);
}

function answerQuestion(question, ledger) {
  const lower = question.toLowerCase();
  const filters = extractFilters(question, ledger.orders);
  const matches = filterOrders(ledger.orders, filters);
  const isRefund = /\b(?:refund(?:s|ed)?|return(?:s|ed)?)\b/i.test(question);
  const count = countMode(question);
  const status = isRefund
    ? "refunded"
    : (/\b(?:void|cancelled|canceled)\b/i.test(question)
      ? "void"
      : (count && !/\bpaid\b/i.test(question) ? null : "paid"));
  const selected = status
    ? matches.filter((order) => order.status === status)
    : matches;
  const currency = targetCurrency(question);

  if (/\b(?:unique|distinct|different)\s+customers?\b|\bhow many customers\b|\bnumber of customers\b/i.test(question)) {
    return new Set(selected.map((order) => order.customer)).size;
  }
  if (/\bhow many (?:different|distinct|unique) products\b/i.test(question)) {
    return new Set(selected.map((order) => order.product)).size;
  }

  const groupField = /\bregions?\b/i.test(question) && /\b(?:by|per|each|across|breakdown)\b/i.test(question)
    ? "region"
    : /\bcustomers?\b/i.test(question) && /\b(?:by|per|each|top|highest|most|largest|biggest|spent|spend)\b/i.test(question)
      ? "customer"
      : /\bproducts?\b/i.test(question) && /\b(?:by|per|each|top|highest|most|largest|best|breakdown)\b/i.test(question)
        ? "product"
        : null;

  if (groupField && /\b(?:top|highest|most|largest|biggest|best|rank|breakdown|per|each|by)\b/i.test(question)) {
    const isUnitMetric = /\b(?:units?|quantity|best-selling|best selling)\b/i.test(question)
      && !/\b(?:revenue|refund amount|amount refunded)\b/i.test(question);
    const metric = isUnitMetric ? "units" : (count ? "orders" : (isRefund ? "refunds" : "revenue"));
    const grouped = new Map();
    for (const order of matches) {
      if (isRefund && order.status !== "refunded") continue;
      if (!isRefund && metric !== "orders" && order.status !== "paid") continue;
      if (!isRefund && metric === "orders" && status && order.status !== status) continue;
      const key = order[groupField];
      const current = grouped.get(key) ?? 0;
      const increment = metric === "units"
        ? order.qty
        : metric === "orders"
          ? 1
          : amountInCurrency(order, currency, ledger.usdPerUnit);
      grouped.set(key, current + increment);
    }
    const rows = [...grouped.entries()]
      .map(([name, value]) => ({
        [groupField]: name,
        [metric]: metric === "orders" || metric === "units" ? value : roundMoney(value),
      }))
      .sort((a, b) => b[metric] - a[metric] || String(a[groupField]).localeCompare(String(b[groupField])));
    if (!rows.length) return groupField === "product" ? null : [];
    if (/\b(?:top|rank)\b/i.test(question)) return rows.slice(0, extractLimit(question));
    if (/\b(?:highest|most|largest|biggest|best)\b/i.test(question)) return rows[0][groupField];
    return rows;
  }

  if (count) {
    if (/\b(?:units?|quantity)\b/i.test(question)) {
      return selected.reduce((sum, order) => sum + order.qty, 0);
    }
    return selected.length;
  }

  if (/\b(?:average|avg|mean)\b/i.test(question)) {
    if (!selected.length) return 0;
    const sum = selected.reduce((total, order) => total + amountInCurrency(order, currency, ledger.usdPerUnit), 0);
    return roundMoney(sum / selected.length);
  }

  if (/\b(?:which|what)\s+product\b/i.test(question) &&
      /\b(?:most|highest|largest|best|top)\b/i.test(question) &&
      !filters.product) {
    const byProduct = new Map();
    for (const order of selected) {
      const current = byProduct.get(order.product) ?? 0;
      byProduct.set(order.product, current + amountInCurrency(order, currency, ledger.usdPerUnit));
    }
    return [...byProduct.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  }

  if (/\b(?:which|what)\s+customer\b/i.test(question) &&
      /\b(?:most|highest|largest|biggest|top)\b/i.test(question) &&
      !filters.customer) {
    const byCustomer = new Map();
    for (const order of selected) {
      const current = byCustomer.get(order.customer) ?? 0;
      byCustomer.set(order.customer, current + amountInCurrency(order, currency, ledger.usdPerUnit));
    }
    return [...byCustomer.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  }

  if (!selected.length) return 0;
  return roundMoney(selected.reduce(
    (sum, order) => sum + amountInCurrency(order, currency, ledger.usdPerUnit),
    0,
  ));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body;
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.question !== "string" ||
    !body.question.trim() ||
    body.question.length > 1000
  ) {
    res.status(400).json({ error: "Expected JSON with a non-empty question string (maximum 1000 characters)." });
    return;
  }

  try {
    const ledger = await loadLedger();
    const answer = answerQuestion(body.question.trim(), ledger);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ answer });
  } catch (error) {
    console.error("Ledger question failed:", error);
    res.status(502).json({ error: "Could not answer the question from the ledger.", details: error.message });
  }
}
