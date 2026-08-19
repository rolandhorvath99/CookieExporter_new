# Cookie Exporter

A Chrome extension (Manifest V3) that lists **every** cookie for the site in the active tab — including the `HttpOnly` ones that `document.cookie` refuses to show you, such as `cf_clearance`, `datadome`, `__cf_bm` and `__Secure-*` session cookies — and copies them out as JSON.

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

Open a site, click the extension icon. The popup shows one row per cookie:

| Column | Meaning |
| --- | --- |
| ☐ | Tick to include the cookie in the JSON export |
| **Name** | Cookie name |
| **Value** | Truncated to one line — click a value to expand it in place |
| **Domain** | A leading `.` means the cookie is shared with subdomains |
| **Path** | Path scope |
| **Expires** | Absolute expiry, or `Session` for cookies that die with the browser |
| **Flags** | `HttpOnly`, `Secure`, `Host`, `Partitioned`, `SameSite=…` |
| **Copy** | `Value` copies the raw value; `JSON` copies just that cookie in export shape |

Controls:

- **Filter** — live substring match across name, value and domain. It narrows the export too.
- **Subdomains** — on by default. Checked, it covers the whole registrable domain (`example.com` plus `api.example.com`, `www.example.com`, …). Unchecked, only cookies scoped to the exact hostname of the tab.
- **Third-party** — off by default, see [Third-party cookies](#third-party-cookies).
- **Strict values** — off by default, see [Value filtering](#value-filtering).
- **Copy JSON** — copies the ticked cookies. With nothing ticked it copies everything currently listed. The header checkbox ticks or clears all listed rows at once.
- **Refresh** — re-read the cookie store (cookies can change while the popup is open).

### Export format

The clipboard gets a `"cookies"` **fragment**, indented one level and without enclosing braces, so it drops straight into a larger config object:

```json
  "cookies": [
    {
      "name": "__eoi",
      "value": "ID=59c5ae054387ab5e:T=1787127081:RT=1787128501:S=AA-AfjaD5qA77TwlBXRXZbSHRHlw"
    },
    {
      "name": "cf_clearance",
      "value": "LLOwu6TpX7dMhugmQVHgHRmRqTUDfIsSGgi3FWc33hg-1787127076-1.2.1.1-O4_o11MB…"
    }
  ]
```

Name and value only — domain, path, flags and expiry are shown in the table but deliberately left out. Because it is a fragment it will not parse on its own; wrap it in `{ }` if you need a standalone document.

## What gets excluded

Three filters run before anything reaches the table, so the list and the JSON always agree.

### Third-party cookies

Off by default: only cookies belonging to the site in the address bar are listed. A page on `example.com` typically also carries cookies for its trackers and ad networks — `__cf_bm` on `.hubspot.com`, `__eoi` on `.doubleclick.net`, `__Secure-1PSID` on `.google.hu`. DevTools' Application panel shows all of those because it lists every origin the page contacted.

Tick **Third-party** to include them. `chrome.cookies` has no "cookies for this tab" query, so the extension injects a one-shot function that reads `performance.getEntriesByType('resource')` in the page and every frame, collects the hostnames the document actually fetched from, reduces them to registrable domains, and queries each. Rows are then grouped by domain with a `1st-party` / `3rd-party` badge, first party first.

Two caveats. If a page refuses injection (Web Store, PDF viewer, strict CSP), the first-party list still renders and the footer says detection failed. And the resource-timing buffer holds roughly the most recent 250 requests, so on a very request-heavy page a domain contacted early can age out — reload the page and reopen the popup.

### One cookie per name

The same name can exist several times — set once on `.example.com` and again on `www.example.com`, on different paths, or on a third-party domain. Only one survives, so the JSON never carries an ambiguous duplicate name. The winner is scored first-party over third-party, then exact-host match, then longer domain, then longer path — the cookie the site actually runs on. Enabling third parties therefore never displaces one of the site's own cookies. The footer reports how many were collapsed.

### Value filtering

Always on:

- empty or whitespace-only values
- values containing characters RFC 6265 forbids in a cookie value — control characters, spaces, `"`, `,`, `;`, `\`
- values with no letter or digit anywhere, which is what catches junk entries whose value is just `.` or `,` or `-`

**Strict values** (off by default) additionally rejects any value containing `$ ? ^ * & # ! ( ) < > { } [ ] | '` or a backtick.

Strict mode is off by default on purpose: those characters are legal in real cookies and in common use. `_ga_XXXXXXX` values look like `GS2.1.s1787127077$o1$g1$t1787127825`, and dropping them would throw away working analytics cookies. Note that a value merely *containing* a dot or dash is always fine — `cf_clearance` and `datadome` values are full of them; only values that are *nothing but* punctuation get dropped.

## How the cookies are collected

A single `chrome.cookies.getAll()` query is not complete on its own, so [popup.js](popup.js) merges several and de-duplicates:

1. **By URL** — cookies the browser would actually send to the current page.
2. **By domain** — adds cookies on other subdomains and on paths that don't match the current page.
3. **Per third-party domain** — only when that toggle is on, one query per domain the page contacted.
4. **By partition key** — repeats every query with a `partitionKey`, the only way to see [CHIPS](https://developers.google.com/privacy-sandbox/cookies/chips) (`Partitioned`) cookies. Unsupported on older Chrome builds, where the query fails silently and the rest still works.

The merged set then goes through the filters above. Results are sorted first-party first, then by domain and name.

`baseDomain()` uses a short list of two-label public suffixes (`co.uk`, `com.au`, …) rather than the full Public Suffix List. It's correct for the common cases; an unusual suffix may scope the subdomain query one label too narrow or too wide. Swapping in a real PSL library is the fix if that ever matters.

## Permissions, and why each is needed

| Permission | Reason |
| --- | --- |
| `cookies` | Read the cookie store — the entire point of the extension |
| `tabs` | Read the active tab's URL to know which site to query |
| `scripting` | Inject the one-shot `performance` reader that finds third-party domains — only runs while that toggle is on, and reads no page content |
| `host_permissions: <all_urls>` | `chrome.cookies` only returns cookies for hosts the extension is allowed to access; this makes it work on any site |

The extension is **read-only and fully local**: it never writes or deletes cookies, has no background service worker, and makes no network requests of any kind. The only injected code is the hostname collector described above, which runs on demand and returns a list of domains. Nothing leaves your browser except what you copy to the clipboard yourself.

## Testing

Unit-level checks for the filtering, de-duplication and export logic run in Node — no browser needed. The test loads [popup.js](popup.js) into a VM with a stubbed DOM and fake `chrome` APIs, then drives it with a fixture cookie store:

```
node test/popup.test.mjs
```

It covers the third-party toggle in both positions, duplicate resolution (including a third-party cookie failing to displace a first-party one of the same name), each value-filter rule, strict mode, selection, and the exact JSON fragment shape down to its indentation.

For a real browser check: load the extension, open a Cloudflare-protected site, and compare against DevTools → Application → Cookies (which also shows `HttpOnly` cookies). In the page console, `document.cookie.split('; ').filter(Boolean).length` should be *lower* than what the popup lists. Right-click the popup → **Inspect** to debug it; reopen the popup after editing `popup.*`, and reload the extension card after editing `manifest.json`.

## Files

```
manifest.json          MV3 manifest — permissions and popup entry point
popup.html             Popup markup
popup.css              Styling, with light and dark themes
popup.js               Cookie collection, filtering and export
icons/                 Toolbar icons (16/32/48/128)
test/popup.test.mjs    Node test harness for the popup logic
```

## Notes and limitations

- Chrome pages (`chrome://`, the Web Store, `about:blank`) have no accessible cookies; the popup says so instead of showing an empty table.
- Cookies are read at the moment the popup opens. Use **Refresh** after logging in or solving a Cloudflare challenge.
- Cookie values are credentials. Anything you copy out of here can be used to impersonate your session — treat it like a password, and don't paste it into shared docs or tickets.
