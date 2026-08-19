"use strict";

/**
 * Cookie Exporter — popup logic.
 *
 * Cookies are read through chrome.cookies, not document.cookie, so HttpOnly
 * cookies (cf_clearance, datadome, __Secure-* session cookies, …) are included.
 * Only cookies belonging to the site in the address bar are listed.
 */

const els = {
  domain: document.getElementById("site-domain"),
  count: document.getElementById("cookie-count"),
  refresh: document.getElementById("refresh"),
  copyJson: document.getElementById("copy-json"),
  filter: document.getElementById("filter"),
  includeSubdomains: document.getElementById("include-subdomains"),
  includeThirdParty: document.getElementById("include-third-party"),
  strictValues: document.getElementById("strict-values"),
  selectAll: document.getElementById("select-all"),
  status: document.getElementById("status"),
  table: document.getElementById("cookie-table"),
  rows: document.getElementById("cookie-rows"),
  footerNote: document.getElementById("footer-note"),
};

/** Cookies for the current site, deduplicated and filtered. */
let cookies = [];
/** Cookie ids ticked for export. */
const selected = new Set();
/** Counters for the footer summary. */
let dropped = { duplicates: 0, invalid: 0 };
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

/** Stable id for a cookie, used for selection and de-duplication. */
function cookieId(cookie) {
  const partition = cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : "";
  return [cookie.domain, cookie.path, cookie.name, partition].join(" ");
}

/**
 * Characters RFC 6265 forbids inside a cookie value: control characters,
 * whitespace, double quote, comma, semicolon and backslash.
 */
const RFC_ILLEGAL = /[\x00-\x20",;\\\x7f]/;
/** Extra characters rejected in strict mode, at the user's request. */
const STRICT_ILLEGAL = /[$?^*&#!()<>{}[\]|'`]/;

/**
 * Is this value worth exporting?
 *
 * Rejects empties and placeholder junk — a value of "." or "-" or "," carries
 * no session state and only pollutes the JSON. Values that merely *contain*
 * dots or dashes are fine: cf_clearance and datadome are full of them.
 */
function isUsableValue(value, { strict }) {
  if (!value || !value.trim()) return false;
  if (RFC_ILLEGAL.test(value)) return false;
  if (!/[a-zA-Z0-9]/.test(value)) return false; // punctuation-only, e.g. "." or ","
  if (strict && STRICT_ILLEGAL.test(value)) return false;
  return true;
}

/**
 * How well a cookie matches the tab's hostname. Used to pick a winner when the
 * same name exists on several domains or paths — the most specific one is the
 * cookie the site actually runs on. A first-party cookie always outranks a
 * third-party one of the same name, so enabling third parties never displaces
 * the site's own cookies.
 */
function specificity(cookie, hostname) {
  const domain = cookie.domain.replace(/^\./, "");
  return (
    (cookie.thirdParty ? 0 : 10000) +
    (domain === hostname ? 1000 : 0) +
    domain.length +
    cookie.path.length
  );
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
 * Every cookie available to the current tab.
 *
 * Overlapping queries are merged because none is complete on its own:
 *   1. by URL           — cookies the browser would send to this exact page
 *   2. by domain        — adds subdomain and non-matching-path cookies
 *   3. per third-party domain — only when the caller asks for them
 *   4. by partition key — CHIPS cookies, invisible to the queries above
 *
 * The result is then reduced to one cookie per name, dropping unusable values.
 */
async function collectCookies(tab, { includeSubdomains, includeThirdParty, strict }) {
  const { hostname, protocol } = new URL(tab.url);
  const site = baseDomain(hostname);

  const queries = [{ url: tab.url }, { domain: includeSubdomains ? site : hostname }];

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

  const topLevelSite = `${protocol}//${site}`;
  for (const query of [...queries]) {
    queries.push({ ...query, partitionKey: { topLevelSite } });
  }

  const results = await Promise.all(queries.map(getAll));

  dropped = { duplicates: 0, invalid: 0 };
  const byName = new Map();
  const seen = new Set();

  for (const cookie of results.flat()) {
    const id = cookieId(cookie);
    if (seen.has(id)) continue; // same cookie returned by two queries
    seen.add(id);

    cookie.thirdParty = baseDomain(cookie.domain) !== site;
    if (cookie.thirdParty && !includeThirdParty) continue;

    if (!isUsableValue(cookie.value, { strict })) {
      dropped.invalid++;
      continue;
    }

    // One cookie per name, so the JSON never carries an ambiguous duplicate.
    const existing = byName.get(cookie.name);
    if (!existing) {
      byName.set(cookie.name, cookie);
      continue;
    }
    dropped.duplicates++;
    if (specificity(cookie, hostname) > specificity(existing, hostname)) {
      byName.set(cookie.name, cookie);
    }
  }

  // First-party first, then third parties grouped by domain.
  return [...byName.values()].sort(
    (a, b) =>
      Number(a.thirdParty) - Number(b.thirdParty) ||
      baseDomain(a.domain).localeCompare(baseDomain(b.domain)) ||
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

/**
 * The export shape — a `"cookies": [...]` fragment indented one level, ready to
 * paste into a larger config object:
 *
 *   "cookies": [
 *     {
 *       "name": "cf_clearance",
 *       "value": "…"
 *     }
 *   ]
 *
 * Stringifying the wrapper and stripping its braces keeps the escaping and the
 * indentation exactly as JSON.stringify produces them.
 */
function toJson(list) {
  const wrapped = JSON.stringify(
    { cookies: list.map(({ name, value }) => ({ name, value })) },
    null,
    2
  );
  return wrapped.split("\n").slice(1, -1).join("\n");
}

async function copyText(text, button) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    button.classList.add("copied");
  } catch (err) {
    console.debug("clipboard write failed", err);
    button.textContent = "Failed";
  }
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1200);
}

function renderGroupRow(domain, isThirdParty, count) {
  const tr = document.createElement("tr");
  tr.className = "group";

  const td = document.createElement("td");
  td.colSpan = 8;

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
  const id = cookieId(cookie);
  const tr = document.createElement("tr");

  const select = document.createElement("td");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = selected.has(id);
  box.title = "Include in the JSON export";
  box.addEventListener("change", () => {
    if (box.checked) selected.add(id);
    else selected.delete(id);
    updateSelectionUi();
  });
  select.append(box);
  tr.append(select);

  const name = document.createElement("td");
  name.className = "name";
  name.textContent = cookie.name;
  tr.append(name);

  const value = document.createElement("td");
  const valueText = document.createElement("div");
  valueText.className = "value truncated";
  valueText.textContent = cookie.value;
  valueText.title = "Click to expand";
  valueText.addEventListener("click", () => valueText.classList.toggle("truncated"));
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

  const copy = document.createElement("td");
  const copyButtons = document.createElement("div");
  copyButtons.className = "copy-buttons";

  const copyValue = document.createElement("button");
  copyValue.type = "button";
  copyValue.className = "mini";
  copyValue.textContent = "Value";
  copyValue.title = "Copy just the value";
  copyValue.addEventListener("click", () => copyText(cookie.value, copyValue));

  const copyOne = document.createElement("button");
  copyOne.type = "button";
  copyOne.className = "mini";
  copyOne.textContent = "JSON";
  copyOne.title = "Copy this cookie as JSON";
  copyOne.addEventListener("click", () => copyText(toJson([cookie]), copyOne));

  copyButtons.append(copyValue, copyOne);
  copy.append(copyButtons);
  tr.append(copy);

  return tr;
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
  els.status.hidden = false;
  els.table.hidden = true;
}

/** Cookies currently listed, i.e. after the text filter. */
function visibleCookies() {
  const needle = els.filter.value.trim().toLowerCase();
  if (!needle) return cookies;
  return cookies.filter((c) =>
    `${c.name} ${c.value} ${c.domain}`.toLowerCase().includes(needle)
  );
}

/** Selection drives the export; with nothing ticked, "Copy JSON" takes them all. */
function exportList() {
  const visible = visibleCookies();
  const picked = visible.filter((c) => selected.has(cookieId(c)));
  return picked.length ? picked : visible;
}

function updateSelectionUi() {
  const visible = visibleCookies();
  const picked = visible.filter((c) => selected.has(cookieId(c))).length;

  els.selectAll.checked = picked > 0 && picked === visible.length;
  els.selectAll.indeterminate = picked > 0 && picked < visible.length;

  els.copyJson.textContent = picked ? `Copy JSON (${picked})` : "Copy JSON";
  els.copyJson.dataset.label = els.copyJson.textContent;
  els.copyJson.disabled = visible.length === 0;
}

function render() {
  const visible = visibleCookies();

  // Domain group headers only earn their space once several domains are listed.
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
  const needle = els.filter.value.trim();
  els.count.textContent =
    needle && total
      ? `${visible.length} of ${total} cookies`
      : `${total} cookie${total === 1 ? "" : "s"}`;

  updateSelectionUi();

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
  const parts = [
    httpOnly
      ? `${httpOnly} HttpOnly cookie${httpOnly === 1 ? "" : "s"} included — invisible to document.cookie.`
      : "No HttpOnly cookies here.",
  ];
  if (els.includeThirdParty.checked) {
    const thirdParty = cookies.filter((c) => c.thirdParty).length;
    parts.push(`${thirdParty} from third-party domains.`);
  }
  if (dropped.duplicates) {
    parts.push(`${dropped.duplicates} duplicate${dropped.duplicates === 1 ? "" : "s"} collapsed by name.`);
  }
  if (dropped.invalid) parts.push(`${dropped.invalid} unusable value${dropped.invalid === 1 ? "" : "s"} hidden.`);
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
      strict: els.strictValues.checked,
    });
  } catch (err) {
    els.count.textContent = "";
    showStatus(`Could not read cookies: ${err.message}`, true);
    return;
  }

  // Drop selections whose cookies are no longer listed.
  const live = new Set(cookies.map(cookieId));
  for (const id of [...selected]) {
    if (!live.has(id)) selected.delete(id);
  }

  updateFooter();
  render();
}

els.refresh.addEventListener("click", load);
els.includeSubdomains.addEventListener("change", load);
els.includeThirdParty.addEventListener("change", load);
els.strictValues.addEventListener("change", load);
els.filter.addEventListener("input", render);
els.copyJson.addEventListener("click", () => copyText(toJson(exportList()), els.copyJson));

els.selectAll.addEventListener("change", () => {
  const visible = visibleCookies();
  for (const cookie of visible) {
    if (els.selectAll.checked) selected.add(cookieId(cookie));
    else selected.delete(cookieId(cookie));
  }
  render();
});

load();
