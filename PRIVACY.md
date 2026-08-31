# Privacy Policy — Cookie Exporter

**Last updated: 31 August 2026**

## Summary

Cookie Exporter does not collect, transmit, store or share any user data. Everything
the extension does happens locally, inside your browser, while the popup is open.

The extension makes no network requests of any kind. It has no server, no analytics,
no telemetry, no crash reporting and no third-party libraries or services.

## What the extension accesses

When you click the extension icon, it accesses the following — and only while the
popup is open:

- **The URL of your active tab.** Used solely to determine which site's cookies to
  look up. It is not stored or transmitted.
- **Cookies for that site.** Read through Chrome's `chrome.cookies` API and displayed
  in the popup, including cookies marked `HttpOnly` that page JavaScript cannot see.
  The extension only reads cookies; it never creates, modifies or deletes them.
- **The list of hostnames the page loaded resources from.** Only when you tick the
  optional "Third-party" checkbox, which is off by default. This is read from the
  page's resource-timing data and consists of domain names only — no page content,
  form data or text is read.

## What happens to that data

It is rendered in the popup and held in memory for as long as the popup is open.
Closing the popup discards it. Nothing is written to disk by the extension, nothing
is placed in browser storage, and nothing leaves your computer.

Two actions move data, and both require an explicit click by you:

- **Copy** places the selected cookie names and values on your system clipboard.
- **Download** saves the selected cookie names and values to a `.json` file on your
  computer, via your browser's normal download mechanism.

In both cases the data goes only where you direct it. The extension has no ability
to send it anywhere else.

## Data sharing

None. No data is sold, transferred or disclosed to any third party. No data is used
to determine creditworthiness or for lending purposes. No data is used for any
purpose beyond displaying cookies to you, which is the extension's single purpose.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `cookies` | Read the cookies of the site in your active tab, including `HttpOnly` cookies. Read-only — the extension never writes or deletes cookies. |
| `tabs` | Read the URL of your active tab, to know which site to look up. |
| `scripting` | Only for the optional "Third-party" feature: a one-shot function that returns the list of domains the page loaded resources from. It reads no page content. |
| `host_permissions: <all_urls>` | Chrome returns cookies only for hosts the extension may access. As a developer tool the extension must work on whichever site you are debugging, which cannot be known in advance. |

## A note on the data you handle

Cookie values are credentials. Anything you copy or download from this extension can
be used to impersonate your session on that website. Treat exported files like
passwords: keep them out of shared documents, tickets and chat, and delete them when
you are done. The extension cannot protect data once you have exported it.

## Security

The extension is read-only with respect to your browser state, has no background
process, and runs only while its popup is open.

## Changes to this policy

Any changes will be published on this page with an updated date above. Material
changes will also be noted in the extension's Chrome Web Store listing.

## Contact

Questions about this policy or the extension: <CONTACT EMAIL>
