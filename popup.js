"use strict";

/**
 * Cookie Exporter — popup logic.
 *
 * Cookies are read through chrome.cookies, not document.cookie, so HttpOnly
 * cookies (cf_clearance, datadome, __Secure-* session cookies, …) are included.
 */

const els = {
  domain: document.getElementById("site-domain"),
  count: document.getElementById("cookie-count"),
  refresh: document.getElementById("refresh"),
  filter: document.getElementById("filter"),
  includeSubdomains: document.getElementById("include-subdomains"),
  includeThirdParty: document.getElementById("include-third-party"),
  status: document.getElementById("status"),
  table: document.getElementById("cookie-table"),
  rows: document.getElementById("cookie-rows"),
  footerNote: document.getElementById("footer-note"),
};

/** Cookies for the current tab, as last loaded. */
let cookies = [];
/** Set when third-party discovery was requested but the page blocked injection. */
let thirdPartyWarning = "";

/**
 * Public suffixes that need two labels to reach the registrable domain.
 * Not a full PSL — just enough to avoid treating "co.uk" as a site.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "web.za",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "com.ar", "com.co", "com.tr", "com.cn", "com.hk",
  "com.sg", "com.my", "com.ph", "com.vn", "com.tw", "com.pl", "com.ua",
  "co.in", "net.in", "org.in", "co.il", "co.id", "co.th", "or.th",
]);

/** Registrable domain ("app.example.co.uk" → "example.co.uk"). */
function baseDomain(hostname) {
  const labels = hostname.replace(/^\.+/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const take = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Identity of a cookie, for de-duplicating overlapping queries. */
function cookieKey(cookie) {
  const partition = cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "";
  return [cookie.storeId, cookie.domain, cookie.path, cookie.name, partition].join(" ");
}

async function getAll(query) {
  try {
    return await chrome.cookies.getAll(query);
  } catch (err) {
    // Older Chrome builds reject unknown query properties (e.g. partitionKey).
    console.debug("cookies.getAll failed for", query, err);
    return [];
  }
}

/**
 * Runs in the page: every hostname this document has talked to.
 *
 * chrome.cookies has no "cookies for this tab" query, so the resource timeline
 * is how we find the third-party domains DevTools would list (trackers, ad
 * networks, CDNs). The buffer holds the most recent ~250 requests.
 */
function collectHostnamesInPage() {
  const hosts = new Set();
  try {
    hosts.add(location.hostname);
  } catch {
    /* opaque origin */
  }
  for (const entry of performance.getEntriesByType("resource")) {
    try {
      hosts.add(new URL(entry.name).hostname);
    } catch {
      /* data: / blob: URLs have no host */
    }
  }
  return [...hosts].filter(Boolean);
}

/** Registrable domains of everything the tab loaded, minus the site itself. */
async function thirdPartyDomains(tabId, site) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: collectHostnamesInPage,
  });

  const domains = new Set();
  for (const frame of results) {
    for (const host of frame.result || []) {
      const domain = baseDomain(host);
      if (domain && domain !== site) domains.add(domain);
    }
  }
  return [...domains].sort();
}

/**
 * Every cookie visible to the current tab.
 *
 * Overlapping queries are merged because none is complete on its own:
 *   1. by URL          — cookies the browser would send to this exact page
 *   2. by domain       — adds subdomain and non-matching-path cookies
 *   3. by partition key — CHIPS cookies, invisible to the queries above
 *   4. per third-party domain — only when the caller asks for them
 */
async function collectCookies(tab, { includeSubdomains, includeThirdParty }) {
  const { hostname, protocol } = new URL(tab.url);
  const site = baseDomain(hostname);
  const topLevelSite = `${protocol}//${site}`;

  const queries = [{ url: tab.url }];
  queries.push({ domain: includeSubdomains ? site : hostname });

  thirdPartyWarning = "";
  if (includeThirdParty) {
    try {
      for (const domain of await thirdPartyDomains(tab.id, site)) {
        queries.push({ domain });
      }
    } catch (err) {
      // Injection is refused on the Web Store, PDF viewer, some CSP setups.
      console.debug("third-party discovery failed", err);
      thirdPartyWarning = "Third-party domains could not be detected on this page.";
    }
  }

  for (const query of [...queries]) {
    queries.push({ ...query, partitionKey: { topLevelSite } });
  }

  const results = await Promise.all(queries.map(getAll));

  const byKey = new Map();
  for (const cookie of results.flat()) {
    cookie.thirdParty = baseDomain(cookie.domain) !== site;
    byKey.set(cookieKey(cookie), cookie);
  }

  // First-party first, then third parties grouped by domain.
  return [...byKey.values()].sort(
    (a, b) =>
      Number(a.thirdParty) - Number(b.thirdParty) ||
      baseDomain(a.domain).localeCompare(baseDomain(b.domain)) ||
      a.domain.replace(/^\./, "").localeCompare(b.domain.replace(/^\./, "")) ||
      a.name.localeCompare(b.name)
  );
}

function formatExpiry(cookie) {
  if (cookie.session || cookie.expirationDate == null) return "Session";
  const date = new Date(cookie.expirationDate * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function flagsFor(cookie) {
  const flags = [];
  if (cookie.httpOnly) flags.push({ label: "HttpOnly", warn: true });
  if (cookie.secure) flags.push({ label: "Secure" });
  if (cookie.hostOnly) flags.push({ label: "Host" });
  if (cookie.partitionKey) flags.push({ label: "Partitioned" });
  if (cookie.sameSite && cookie.sameSite !== "unspecified") {
    const sameSite = { no_restriction: "SameSite=None", lax: "SameSite=Lax", strict: "SameSite=Strict" };
    flags.push({ label: sameSite[cookie.sameSite] || cookie.sameSite });
  }
  return flags;
}

function renderGroupRow(domain, isThirdParty, count) {
  const tr = document.createElement("tr");
  tr.className = "group";

  const td = document.createElement("td");
  td.colSpan = 6;

  const wrap = document.createElement("div");
  wrap.className = "group-label";

  const label = document.createElement("span");
  label.textContent = domain;
  wrap.append(label);

  const badge = document.createElement("span");
  badge.className = isThirdParty ? "chip third-party" : "chip first-party";
  badge.textContent = isThirdParty ? "3rd-party" : "1st-party";
  wrap.append(badge);

  const tally = document.createElement("span");
  tally.className = "group-count";
  tally.textContent = `${count} cookie${count === 1 ? "" : "s"}`;
  wrap.append(tally);

  td.append(wrap);
  tr.append(td);
  return tr;
}

function renderRow(cookie) {
  const tr = document.createElement("tr");

  const name = document.createElement("td");
  name.className = "name";
  name.textContent = cookie.name;
  tr.append(name);

  const value = document.createElement("td");
  const valueText = document.createElement("div");
  valueText.className = cookie.value ? "value truncated" : "value empty";
  valueText.textContent = cookie.value || "(empty)";
  if (cookie.value) {
    valueText.title = "Click to expand";
    valueText.addEventListener("click", () => {
      valueText.classList.toggle("truncated");
    });
  }
  value.append(valueText);
  tr.append(value);

  const domain = document.createElement("td");
  domain.className = "domain";
  domain.textContent = cookie.domain;
  tr.append(domain);

  const path = document.createElement("td");
  path.className = "path";
  path.textContent = cookie.path;
  tr.append(path);

  const expires = document.createElement("td");
  expires.className = "expires";
  expires.textContent = formatExpiry(cookie);
  tr.append(expires);

  const flags = document.createElement("td");
  const flagList = document.createElement("div");
  flagList.className = "flags";
  for (const flag of flagsFor(cookie)) {
    const chip = document.createElement("span");
    chip.className = flag.warn ? "chip httponly" : "chip";
    chip.textContent = flag.label;
    flagList.append(chip);
  }
  flags.append(flagList);
  tr.append(flags);

  return tr;
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
  els.status.hidden = false;
  els.table.hidden = true;
}

function render() {
  const needle = els.filter.value.trim().toLowerCase();
  const visible = needle
    ? cookies.filter((c) =>
        `${c.name} ${c.value} ${c.domain}`.toLowerCase().includes(needle)
      )
    : cookies;

  // Group headers only earn their space once more than one domain is listed.
  const grouped = els.includeThirdParty.checked;
  const rows = [];
  let currentGroup = null;
  visible.forEach((cookie, index) => {
    if (grouped) {
      const group = baseDomain(cookie.domain);
      if (group !== currentGroup) {
        currentGroup = group;
        let count = 0;
        for (let i = index; i < visible.length && baseDomain(visible[i].domain) === group; i++) {
          count++;
        }
        rows.push(renderGroupRow(group, cookie.thirdParty, count));
      }
    }
    rows.push(renderRow(cookie));
  });
  els.rows.replaceChildren(...rows);

  const total = cookies.length;
  els.count.textContent =
    needle && total ? `${visible.length} of ${total} cookies` : `${total} cookie${total === 1 ? "" : "s"}`;

  if (!total) {
    showStatus("No cookies found for this site.");
    return;
  }
  if (!visible.length) {
    showStatus("No cookies match the filter.");
    return;
  }

  els.status.hidden = true;
  els.table.hidden = false;
}

function updateFooter() {
  const httpOnly = cookies.filter((c) => c.httpOnly).length;
  const thirdParty = cookies.filter((c) => c.thirdParty).length;

  const parts = [];
  parts.push(
    httpOnly
      ? `${httpOnly} HttpOnly cookie${httpOnly === 1 ? "" : "s"} included — invisible to document.cookie.`
      : "No HttpOnly cookies here."
  );
  if (els.includeThirdParty.checked) {
    parts.push(`${thirdParty} from third-party domains.`);
  }
  if (thirdPartyWarning) parts.push(thirdPartyWarning);

  els.footerNote.textContent = parts.join(" ");
}

async function load() {
  els.status.hidden = false;
  els.status.classList.remove("error");
  els.status.textContent = "Reading cookies…";
  els.table.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url || !/^https?:/.test(tab.url)) {
    els.domain.textContent = "Unsupported page";
    els.count.textContent = "";
    showStatus("Open an http:// or https:// page — browser pages have no cookies to read.");
    return;
  }

  const { hostname } = new URL(tab.url);
  els.domain.textContent = hostname;

  try {
    cookies = await collectCookies(tab, {
      includeSubdomains: els.includeSubdomains.checked,
      includeThirdParty: els.includeThirdParty.checked,
    });
  } catch (err) {
    els.count.textContent = "";
    showStatus(`Could not read cookies: ${err.message}`, true);
    return;
  }

  updateFooter();
  render();
}

els.refresh.addEventListener("click", load);
els.includeSubdomains.addEventListener("change", load);
els.includeThirdParty.addEventListener("change", load);
els.filter.addEventListener("input", render);

load();
