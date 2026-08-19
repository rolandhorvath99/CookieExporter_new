import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";

const SRC = new URL("../popup.js", import.meta.url).pathname;

function node(tag = "div") {
  const n = {
    tagName: tag,
    children: [],
    dataset: {},
    className: "",
    textContent: "",
    checked: false,
    indeterminate: false,
    disabled: false,
    hidden: false,
    value: "",
    title: "",
    type: "",
    colSpan: 1,
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    append(...kids) { n.children.push(...kids); },
    appendChild(kid) { n.children.push(kid); },
    addEventListener(evt, fn) { (n._on ||= {})[evt] = fn; },
    replaceChildren(...kids) { n.children = kids; },
  };
  return n;
}

const byId = new Map();
const el = (id) => {
  if (!byId.has(id)) byId.set(id, node(id));
  return byId.get(id);
};

// The site under test is www.example.com; cookies below are the fixture store.
const COOKIES = [
  // kept: dots and dashes are normal inside a Cloudflare value
  { name: "cf_clearance", value: "_XNZB8t-1787127078.825327-1.0.1.1-JyqVikN3", domain: ".example.com", path: "/", secure: true, httpOnly: true, session: false, expirationDate: 1800000000 },
  // dropped: foreign domain
  { name: "__cf_bm", value: "IdkrYGjNRe5i", domain: ".hubspot.com", path: "/", httpOnly: true },
  // dropped: value is punctuation only
  { name: "junk_dot", value: ".", domain: ".example.com", path: "/" },
  { name: "junk_comma", value: ",", domain: ".example.com", path: "/" },
  { name: "junk_empty", value: "", domain: ".example.com", path: "/" },
  // dropped: comma is illegal inside a cookie value per RFC 6265
  { name: "junk_rfc", value: "a,b", domain: ".example.com", path: "/" },
  // duplicate pair: the host-specific one must win
  { name: "_ga", value: "GA1.1.wide", domain: ".example.com", path: "/" },
  { name: "_ga", value: "GA1.1.specific", domain: "www.example.com", path: "/" },
  // strict-mode casualty: $ separators
  { name: "_ga_CLPGWJBZ9R", value: "GS2.1.s1787127077$o1$g1", domain: ".example.com", path: "/" },
  // third-party only: same name as nothing first-party, so it survives when enabled
  { name: "__eoi_tracker", value: "ID=bed4fbc17d409330", domain: ".hubspot.com", path: "/" },
  // third-party clash: the first-party _ga must win even with third parties on
  { name: "_ga", value: "GA1.1.hubspot", domain: ".hubspot.com", path: "/" },
];


const sandbox = {
  console,
  setTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
  URL,
  Date,
  JSON,
  Set,
  Map,
  Number,
  document: { getElementById: el, createElement: node },
  chrome: {
    tabs: { query: async () => [{ id: 1, url: "https://www.example.com/page" }] },
    cookies: {
      // Return everything; popup.js is responsible for scoping and dedupe.
      getAll: async (q) => (q.partitionKey ? [] : COOKIES.map((c) => ({ ...c }))),
    },
    scripting: {
      executeScript: async () => [{ result: ["tracker.hubspot.com", "www.example.com"] }],
    },
  },
};

const ctx = vm.createContext(sandbox);

// Defaults that the real checkboxes would have.
el("include-subdomains").checked = true;
el("strict-values").checked = false;
el("filter").value = "";

// `let`/`const` at top level are lexical, not properties of the global object,
// so expose the bits the assertions need.
const EPILOGUE = `
globalThis.__t = {
  get cookies() { return cookies; },
  get dropped() { return dropped; },
  selected, load, render, toJson, exportList, cookieId,
};`;

vm.runInContext(fs.readFileSync(SRC, "utf8") + EPILOGUE, ctx);
const t = sandbox.__t;

const settle = () => new Promise((r) => setTimeout(r, 20));
await settle(); // let load() finish

// Array.from rebuilds in the host realm — a vm-realm array fails deepStrictEqual.
const names = () => Array.from(t.cookies, (c) => c.name);
const rowCount = () => el("cookie-rows").children.length;

console.log("listed:", names());
console.log("footer:", el("footer-note").textContent);

assert.deepStrictEqual(names(), ["_ga", "_ga_CLPGWJBZ9R", "cf_clearance"], "wrong cookie set");
assert.strictEqual(rowCount(), 3, "row count mismatch");

const ga = t.cookies.find((c) => c.name === "_ga");
assert.strictEqual(ga.value, "GA1.1.specific", "duplicate resolution picked the less specific cookie");
assert.strictEqual(ga.domain, "www.example.com");

assert.strictEqual(t.dropped.duplicates, 1, "duplicate not counted");
assert.strictEqual(t.dropped.invalid, 4, "invalid values not counted");

// Export shape: a `"cookies": [...]` fragment, so it only parses once braced.
const parseFragment = (s) => JSON.parse(`{${s}}`);

const json = t.toJson(t.exportList());
console.log("\n--- Copy JSON (nothing selected → all listed) ---\n" + json);

const lines = json.split("\n");
assert.strictEqual(lines[0], '  "cookies": [', "fragment must open with an indented cookies key");
assert.strictEqual(lines.at(-1), "  ]", "fragment must close with an indented bracket");
assert.strictEqual(lines[1], "    {", "objects indent four spaces");
assert.strictEqual(lines[2].slice(0, 12), '      "name"', "keys indent six spaces");

const parsed = parseFragment(json);
assert.deepStrictEqual(Object.keys(parsed), ["cookies"], "top-level key must be 'cookies'");
assert.deepStrictEqual(Object.keys(parsed.cookies[0]), ["name", "value"], "only name and value");
assert.strictEqual(parsed.cookies.length, 3);

// Selecting a subset
t.selected.add(t.cookieId(t.cookies.find((c) => c.name === "cf_clearance")));
const oneOnly = parseFragment(t.toJson(t.exportList()));
assert.strictEqual(oneOnly.cookies.length, 1, "selection ignored");
assert.strictEqual(oneOnly.cookies[0].name, "cf_clearance");
console.log("\n--- Copy JSON (one selected) ---\n" + t.toJson(t.exportList()));

// Strict mode drops the $-laden GA value
el("strict-values").checked = true;
await t.load();
await settle();
console.log("\nstrict listed:", names());
assert.deepStrictEqual(names(), ["_ga", "cf_clearance"], "strict mode did not drop $ values");

// Filter narrows both the table and the export
el("strict-values").checked = false;
await t.load();
await settle();
el("filter").value = "cf_";
t.render();
assert.strictEqual(rowCount(), 1, "filter did not narrow rows");
assert.strictEqual(parseFragment(t.toJson(t.exportList())).cookies.length, 1, "export ignored filter");

// Third-party toggle
el("filter").value = "";
t.selected.clear();
el("include-third-party").checked = true;
await t.load();
await settle();
console.log("\nwith third-party:", names());

assert.ok(names().includes("__eoi_tracker"), "third-party cookie not listed when enabled");
assert.ok(names().includes("cf_clearance"), "first-party cookies must remain");

const gaAfter = t.cookies.find((c) => c.name === "_ga");
assert.strictEqual(gaAfter.value, "GA1.1.specific", "third-party _ga displaced the first-party one");
assert.strictEqual(gaAfter.thirdParty, false);

const tracker = t.cookies.find((c) => c.name === "__eoi_tracker");
assert.strictEqual(tracker.thirdParty, true, "third-party flag not set");
assert.ok(
  t.cookies.findIndex((c) => c.thirdParty) > t.cookies.findIndex((c) => !c.thirdParty),
  "first-party cookies must sort ahead of third-party ones"
);

// A group header row precedes each domain block, so rows outnumber cookies.
assert.ok(rowCount() > t.cookies.length, "group headers missing when third-party is on");

el("include-third-party").checked = false;
await t.load();
await settle();
assert.ok(!names().includes("__eoi_tracker"), "third-party cookie leaked with the toggle off");

console.log("\n✓ all assertions passed");
