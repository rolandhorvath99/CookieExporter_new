# Cookie Exporter

A Chrome extension (Manifest V3) that lists **every** cookie for the site in the active tab — including the `HttpOnly` ones that `document.cookie` refuses to show you, such as `cf_clearance`, `datadome`, `__cf_bm` and `__Secure-*` session cookies.

## Why `document.cookie` isn't enough

Bot-protection and session cookies are almost always set with the `HttpOnly` flag, which tells the browser: *never expose this to page JavaScript*. So anything that reads `document.cookie` — a console snippet, a bookmarklet, an injected content script — sees a partial list with those exact cookies missing.

Extensions can use the [`chrome.cookies`](https://developer.chrome.com/docs/extensions/reference/api/cookies) API instead, which reads straight from the browser's cookie store and is not subject to the `HttpOnly` restriction. That's what this extension does.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc…).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Pin the cookie icon to the toolbar so it's one click away.

No build step, no dependencies — the folder is the extension.

## Usage

Open a site, click the extension icon. The popup shows a table of every cookie for that site:

| Column | Meaning |
| --- | --- |
| **Name** | Cookie name |
| **Value** | Truncated to one line — click a value to expand it in place |
| **Domain** | A leading `.` means the cookie is shared with subdomains |
| **Path** | Path scope |
| **Expires** | Absolute expiry, or `Session` for cookies that die with the browser |
| **Flags** | `HttpOnly`, `Secure`, `Host`, `Partitioned`, `SameSite=…` |

Controls:

- **Filter** — live substring match across name, value and domain.
- **Include subdomains** — on by default. Checked, it lists cookies for the whole registrable domain (`example.com` plus `api.example.com`, `www.example.com`, …). Unchecked, only cookies scoped to the exact hostname of the tab.
- **Include third-party** — off by default. Checked, it also lists cookies belonging to every other domain the page loaded resources from — HubSpot, DoubleClick, LinkedIn and friends. Rows are then grouped by domain with a `1st-party` / `3rd-party` badge. This is what makes the list match DevTools' Application panel.
- **Refresh** — re-read the cookie store (cookies can change while the popup is open).

### First-party vs third-party

By default the popup shows cookies for the site in the address bar only. DevTools' Application panel does something different: it lists cookies for **every origin the page contacted**, which is why a page on `example.com` shows a `__cf_bm` on `.hubspot.com` there but not here — that cookie belongs to HubSpot's CDN, not to the site you're visiting. Turn on **Include third-party** to see those too.

The footer tells you how many `HttpOnly` cookies are in the list — i.e. how many you would have missed via `document.cookie`.

## How the cookies are collected

A single `chrome.cookies.getAll()` query is not complete on its own, so [popup.js](popup.js) merges several and de-duplicates by `(store, domain, path, name, partitionKey)`:

1. **By URL** — cookies the browser would actually send to the current page.
2. **By domain** — adds cookies on other subdomains and on paths that don't match the current page.
3. **Per third-party domain** — only when the toggle is on. `chrome.cookies` has no "cookies for this tab" query, so the extension injects a one-shot function that reads `performance.getEntriesByType('resource')` in the page and every frame, collects the hostnames the document actually fetched from, reduces them to registrable domains, and queries each. If a page refuses injection (Web Store, PDF viewer, strict CSP), the first-party list still renders and the footer says third-party detection failed.
4. **By partition key** — repeats every query with a `partitionKey`, which is the only way to see [CHIPS](https://developers.google.com/privacy-sandbox/cookies/chips) (`Partitioned`) cookies. Unsupported on older Chrome builds, where the query fails silently and the rest still works.

Results are sorted first-party first, then grouped by registrable domain and name.

The resource-timing buffer holds roughly the most recent 250 requests, so on a very request-heavy page a domain contacted early may age out and its cookies be missed. Refreshing the page and reopening the popup brings it back.

`baseDomain()` uses a short list of two-label public suffixes (`co.uk`, `com.au`, …) rather than the full Public Suffix List. It's correct for the common cases; an unusual suffix may cause the subdomain query to be scoped one label too narrow or too wide. Swapping in a real PSL library is the fix if that ever matters.

## Permissions, and why each is needed

| Permission | Reason |
| --- | --- |
| `cookies` | Read the cookie store — the entire point of the extension |
| `tabs` | Read the active tab's URL to know which site to query |
| `scripting` | Inject the one-shot `performance` reader that finds third-party domains — only runs when the toggle is on, reads no page content |
| `host_permissions: <all_urls>` | `chrome.cookies` only returns cookies for hosts the extension is allowed to access; this makes it work on any site |

The extension is **read-only and fully local**: it never writes or deletes cookies, has no background service worker, and makes no network requests of any kind. The only injected code is the hostname collector above, which runs on demand and returns a list of domains — no page content is read. Nothing leaves your browser.

## Files

```
manifest.json    MV3 manifest — permissions and popup entry point
popup.html       Popup markup
popup.css        Styling, with light and dark themes
popup.js         Cookie collection and rendering
icons/           Toolbar icons (16/32/48/128)
```

## Roadmap

Planned, not yet built:

- **Copy to clipboard** — copy a single cookie value, or all of them.
- **JSON export** — convert the visible cookies into JSON, in a format that other tools accept (Puppeteer / Playwright `setCookie()`, EditThisCookie, and a plain `Cookie:` request header string).
- **Selection** — checkboxes to export a subset rather than everything.

The groundwork is in place: `collectCookies()` in [popup.js](popup.js) already returns plain [`chrome.cookies.Cookie`](https://developer.chrome.com/docs/extensions/reference/api/cookies#type-Cookie) objects, and the module-level `cookies` array holds the current list. An export step is a matter of mapping that array to the target shape and calling `navigator.clipboard.writeText()`.

## Notes and limitations

- Chrome pages (`chrome://`, the Web Store, `about:blank`) have no accessible cookies; the popup says so instead of showing an empty table.
- Cookies are read at the moment the popup opens. Use **Refresh** after logging in or solving a Cloudflare challenge.
- Cookie values are credentials. Anything you copy out of here can be used to impersonate your session — treat it like a password, and don't paste it into shared docs or tickets.
