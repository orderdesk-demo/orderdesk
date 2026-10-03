# OrderDesk: Field Sales Order Management

A polished prototype for a **field sales team placing orders**: sales reps capture orders (online or
offline), update their status in one click, and track their quota. Sales leadership sees revenue,
attainment, pipeline and regions on a dashboard of its own.

Built for the DevRev Solutions Engineer **Rapid Prototype Challenge** as the companion to the
*Offline Mode for Mobile Order Processing* product spec.

- **Backend:** Node.js + Express REST API with input validation
- **Storage:** SQLite via `better-sqlite3`, behind a swappable storage module (with an automatic JSON-file fallback)
- **Frontend:** plain HTML, CSS and vanilla JS ES modules (no framework, no build step)
- **AI-ready:** an MCP server lets agents such as DevRev Computer query orders live
- **Single process:** one `npm start` serves the UI, the API and the MCP endpoint

---

## What it does

**Mock login** (`#/login`)
- A sign-in page for demo flow. **There is no real authentication:** any email and password work, the
  session lives only in the browser, and the API is not protected.

**Leadership dashboard** (`#/leadership`)
- **AI Insights:** a plain-language summary of all orders.
- **Needs attention:** open orders with no update in 48 hours or more.
- **Date range filter:** last 7 days, 4 weeks or 12 weeks. It scopes everything below it.
- **KPI tiles:** booked revenue, quota attainment, orders, average order value, open pipeline, and the share
  of orders captured offline. Each has a change vs the previous period.
- **Charts:**
  - booked revenue by week (or by day for 7 days)
  - quota attainment by rep, against a 100% line
  - order value by stage
  - booked revenue by region

  Every chart has hover tooltips and a **Show table** view.
- **Rep leaderboard.** Selecting a rep opens their dashboard.

**Sales Rep dashboard** (`#/rep/:id`)
- **"Viewing as" selector** for any of the 6 reps.
- **Month-to-date revenue** against monthly quota, with a pace status (On track / At risk / Behind pace) and team rank.
- **Last-30-days KPIs** and **Needs follow-up** (the rep's stale open orders).
- **My orders** table:
  - **one-click status updates**: each status is a colored dropdown that saves immediately and rolls back on error
  - View, Edit and Delete on every row
- **+ New order:** the form defaults to the viewed rep, prefills list prices from the product catalog,
  shows a live order value, and has a "Captured offline" flag.

**Order detail** (`#/orders/:id`)
- **Every field,** including value, sales rep and region, and how the order was captured.
- **Status stepper:** New → Processing → Shipped → Delivered, with one click to move, **Cancel order**, and a click on any step to reopen.
- **Edit and Delete.** "Back" returns to the dashboard you came from. The URL can be bookmarked.

---

## How to run it

Requires **Node.js 20.12+** (tested on Node 24.13 / macOS).

```bash
npm install
npm start
```

Open **http://localhost:3000** and click **Sign in**.

| Option | How |
|---|---|
| Change port | `PORT=4000 npm start` |
| Force the JSON store | `STORE_ENGINE=json npm start` |
| Store data elsewhere | `DATA_DIR=/some/dir npm start` |
| Fresh demo data | stop the server, `npm run db:reset`, then `npm start` |

The first start creates the database with **6 sales reps and 300 orders over the last 180 days**.
A database from an earlier version is **migrated automatically** (orders and ids are kept, reps and list
prices are backfilled). Use `npm run db:reset` if you'd rather have the full demo history.

---

## Architecture

```
          Browser: public/index.html + app.js (hash router) + js/*.js modules
                                   │  fetch() JSON
                                   ▼
  ┌───────────────────────── one Node.js process ─────────────────────────┐
  │  server.js    static files · REST routes · validation                 │
  │     ├── metrics.js    dashboard math (shared by REST + MCP)           │
  │     ├── insights.js   plain-language summary (shared by REST + MCP)   │
  │     ├── mcp.js        POST /mcp: tools for AI agents                  │
  │     └── devrev.js     optional sync of orders into DevRev             │
  │                              │ await store.*()                        │
  │  store.js  ── engine-agnostic interface ──┐                           │
  │     ├── SQLite engine (better-sqlite3) → orders.db    (default)       │
  │     └── JSON engine                    → orders.json  (fallback)      │
  └───────────────────────────────────────────────────────────────────────┘
```

```
.
├── server.js           Express app: REST routes, validation, static hosting, MCP mount
├── store.js            Storage layer: schema, migrations, seed data (the only file that knows SQL)
├── metrics.js          Leadership + rep dashboard metrics (pure functions)
├── insights.js         Plain-language order summary
├── mcp.js              MCP server: order tools for AI agents like DevRev Computer
├── devrev.js           DevRev integration: syncs orders into DevRev as custom objects
├── tools/
│   ├── devrev-sync.js  CLI: npm run devrev:setup / devrev:sync / devrev:list
│   ├── reset-db.js     CLI: npm run db:reset
│   └── report.js       CLI: npm run report / report:publish (sales snapshot for AI tools)
├── reports/
│   └── sales-snapshot.md  Generated: order book + sales performance in readable form
├── data/
│   └── orders.csv      Generated: every order as a row
├── tests/
│   ├── run.mjs         npm test: runs every suite below except the browser test
│   ├── api.test.mjs    REST API on both storage engines
│   ├── store.test.mjs  Seeding, migrations, dashboard metrics
│   ├── mcp.test.mjs    MCP tools via the official SDK client
│   ├── devrev.test.mjs DevRev sync against a mock DevRev API
│   └── ui.test.mjs     npm run test:ui: headless Chrome end-to-end
├── public/
│   ├── index.html      Login, app shell with tabs, order modal
│   ├── styles.css      Navy / teal / amber theme; validated chart colors
│   ├── app.js          Entry point: hash router, mock session, tabs
│   └── js/
│       ├── api.js          fetch() client
│       ├── session.js      mock sign-in (browser only)
│       ├── leadership.js   Leadership dashboard
│       ├── rep.js          Sales Rep dashboard
│       ├── detail.js       Order detail + stepper
│       ├── order-form.js   New / Edit order modal
│       ├── charts.js       Dependency-free SVG/HTML charts, tooltips, table views
│       ├── format.js       Money, dates, pills
│       └── ui.js           Toasts
├── .env.example        Template for DEVREV_PAT, MCP_API_KEY and other settings
└── package.json
```

**Design choices**

- **Layering:**
  - `server.js` handles HTTP and never touches SQL.
  - `store.js` handles storage and never sees `req`/`res`.
  - `metrics.js` is pure math, so the dashboards and the MCP tools always report identical numbers.
- **Server-side aggregation:** dashboards come from `/api/dashboard/*` endpoints, not from the browser
  crunching raw orders. That's the shape a mobile app or an AI agent needs too.
- **Async-ready:** route handlers `await` every store call, so an async engine (Postgres, a remote API)
  can replace SQLite without changing any route code.
- **Defence in depth:**
  - the API validates every write
  - the SQLite schema repeats the key rules as `CHECK` constraints
  - foreign keys are enforced
- **Stable ids:** `AUTOINCREMENT` (and a persisted `nextId` in the JSON engine) means deleted ids are
  never reused, including across the schema migration. This matters for offline devices and synced systems.
- **Charts follow a data-visualization checklist:**
  - thin marks and hairline grids
  - selective labels
  - tooltips on hover and keyboard focus
  - a table view for every chart
  - colors checked with a palette validator, not by eye

### Storage fallback

`better-sqlite3` is a native module. It installed and ran cleanly on the build machine, so **SQLite is
the active engine**. To keep the app runnable wherever it's cloned:

- `better-sqlite3` is listed under `optionalDependencies`, so `npm install` still succeeds if it can't compile.
- `store.init()` tries SQLite first. If the module can't load, it switches to a JSON-file store with the
  **same interface and output**, including the migration and seed data.
- The startup log always states which engine is running.

---

## Data model

Two entities: a **sales rep** places many **orders**.

**`sales_reps`**

| Column | Type | Rules |
|---|---|---|
| `id` | INTEGER | Primary key, auto-increment |
| `name` | TEXT | Required |
| `email` | TEXT | Required, unique |
| `region` | TEXT | One of `North`, `South`, `East`, `West` |
| `monthly_quota` | INTEGER | USD, ≥ 0 |
| `created_at` | TEXT | ISO-8601 UTC |

**`orders`**

| Column | Type | Rules |
|---|---|---|
| `id` | INTEGER | Primary key, auto-increment, never reused |
| `customer_name` | TEXT | Required, non-empty, ≤ 120 chars (trimmed) |
| `product` | TEXT | Required, non-empty, ≤ 120 chars (trimmed) |
| `quantity` | INTEGER | Required, integer ≥ 1 (≤ 100,000) |
| `unit_price` | REAL | Required, USD ≥ 0 with at most 2 decimals |
| `status` | TEXT | `New`, `Processing`, `Shipped`, `Delivered` or `Cancelled`. Defaults to `New` |
| `rep_id` | INTEGER | Required, foreign key → `sales_reps.id` |
| `placed_offline` | INTEGER (0/1) | Captured without connectivity and synced later. Defaults to 0 |
| `created_at` | TEXT | ISO-8601 UTC, set on create |
| `updated_at` | TEXT | ISO-8601 UTC, set on create and every update |

**Derived on read (never stored):**
- `total` = `quantity × unit_price`
- `rep_name` and `rep_region`, from the join with `sales_reps`

In the API, `placed_offline` is a boolean.

```sql
CREATE TABLE orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name  TEXT    NOT NULL CHECK (length(trim(customer_name)) > 0),
  product        TEXT    NOT NULL CHECK (length(trim(product)) > 0),
  quantity       INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity >= 1),
  unit_price     REAL    NOT NULL CHECK (unit_price >= 0),
  status         TEXT    NOT NULL DEFAULT 'New'
                 CHECK (status IN ('New','Processing','Shipped','Delivered','Cancelled')),
  rep_id         INTEGER NOT NULL REFERENCES sales_reps (id),
  placed_offline INTEGER NOT NULL DEFAULT 0 CHECK (placed_offline IN (0, 1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
-- indexes on status, rep_id, created_at, updated_at
```

**Metric definitions** (`metrics.js`):

| Metric | Definition |
|---|---|
| Booked revenue | Total value of orders that aren't `Cancelled` |
| Open | `New` or `Processing` |
| Stale / needs attention | Open with no update for 48 hours or more |
| Quota attainment | Booked revenue ÷ quota (monthly quota prorated to the window: `× days / 30`) |
| Pace (rep) | Month-to-date revenue vs quota × share of the month elapsed. Below 80% of that is "Behind pace" |

**Seed data:**
- **6 reps across 4 regions,** with monthly quotas from $35K to $50K.
- **8 catalog products,** from Mobile Card Reader ($59) to Self-Checkout Kiosk ($4,999).
- **300 orders over 180 days.** Status follows each order's age, about 30% were captured offline, and a
  few open orders are deliberately stale.
- **Deterministic:** a seeded random generator creates the data, so it's the same on every machine.

---

## API reference

Base URL: `http://localhost:3000/api`. All bodies are JSON.
Every error response has the same shape: `{ "errors": ["...", "..."] }`.

| Method | Path | Success | Errors |
|---|---|---|---|
| `GET` | `/api/orders` | `200` orders, newest first. Optional `?rep_id=` and `?status=` | `400` bad filter |
| `GET` | `/api/orders/:id` | `200` order | `400` bad id · `404` |
| `POST` | `/api/orders` | `201` created order (+ `Location` header) | `400` validation |
| `PUT` | `/api/orders/:id` | `200` updated order (partial updates allowed) | `400` validation · `404` |
| `DELETE` | `/api/orders/:id` | `204` | `400` bad id · `404` |
| `GET` | `/api/reps` · `/api/reps/:id` | `200` sales reps | `400` · `404` |
| `GET` | `/api/products` | `200` catalog with list prices | none |
| `GET` | `/api/dashboard/leadership?days=28` | `200` KPIs, trend, reps, regions, pipeline, attention | `400` days not 1–365 |
| `GET` | `/api/dashboard/rep/:id` | `200` month-to-date pace, last 30 days, open orders, follow-ups | `400` · `404` |
| `GET` | `/api/insights` | `200` plain-language summary | none |
| `POST` | `/mcp` | MCP (Streamable HTTP) for AI agents; see below | `401` if a key is set |

### Validation rules

- **`POST` required fields:** `customer_name`, `product`, `quantity`, `unit_price`, `rep_id`.
  `status` defaults to `New` and `placed_offline` to `false`.
- **`PUT`:** any subset of the writable fields; at least one is required.
- **`quantity`** must be a JSON integer ≥ 1 (`"3"` and `2.5` are rejected).
- **`unit_price`** must be a number ≥ 0 with at most 2 decimals.
- **`rep_id`** must reference an existing sales rep.
- **Read-only fields:** `id`, `total`, `rep_name`, `rep_region`, `created_at` and `updated_at` are
  server-managed and ignored if sent, so a `GET` response can be sent straight back in a `PUT`. Any other
  unknown field is rejected.
- **Errors:** all errors are returned together. Malformed JSON returns `400`, and unknown `/api/*`
  routes return a JSON `404`.

### Examples

**Create**

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer_name":"Acme Retail","product":"POS Terminal","quantity":3,"unit_price":899,"rep_id":1}'
```
```json
201 Created
{ "id": 301, "customer_name": "Acme Retail", "product": "POS Terminal", "quantity": 3,
  "unit_price": 899, "total": 2697, "status": "New", "rep_id": 1, "rep_name": "Priya Sharma",
  "rep_region": "West", "placed_offline": false,
  "created_at": "2026-09-15T08:30:00.000Z", "updated_at": "2026-09-15T08:30:00.000Z" }
```

**Validation failure**

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer_name":"X","product":"Y","quantity":0,"unit_price":10,"rep_id":1}'
```
```json
400 Bad Request
{ "errors": ["quantity must be a positive integer"] }
```

**One-click status update (partial PUT)**

```bash
curl -X PUT http://localhost:3000/api/orders/42 \
  -H 'Content-Type: application/json' \
  -d '{"status":"Shipped"}'
```

**One rep's open work**

```bash
curl 'http://localhost:3000/api/orders?rep_id=3&status=Processing'
```

**Leadership dashboard** (abridged; values depend on the data)

```json
{
  "range": { "days": 28, "start": "…", "end": "…" },
  "kpis": { "revenue": 219619, "revenue_change_pct": -7.1, "orders": 51, "avg_order_value": 4575.4,
            "quota": 233333.34, "attainment": 0.9412, "open_orders": 14, "open_pipeline_value": 74608,
            "offline_share": 0.2157, "offline_share_change_pts": -10 },
  "trend": { "granularity": "week", "points": [{ "start": "…", "end": "…", "revenue": 52210, "orders": 12 }] },
  "reps": [{ "id": 5, "name": "Aisha Patel", "region": "West", "revenue": 63571, "quota": 35466.67,
             "attainment": 1.7924, "orders": 11, "open_orders": 3, "stale_orders": 1 }],
  "regions": [{ "region": "West", "revenue": 106600, "attainment": 1.2979, "reps": 2 }],
  "pipeline": [{ "status": "New", "orders": 3, "value": 10281 }],
  "attention": { "stale_hours": 48, "total": 13, "orders": ["… open orders, longest waiting first …"] }
}
```

> **About "AI Insights":** the summary is generated by deterministic rules in `insights.js`, with no
> external model call. That keeps the demo fast, free and offline-capable. It's the single seam where an
> LLM could be plugged in: give it the structured aggregates and ask for a narrative, while the numbers stay
> machine-readable facts the model can't invent.

---

## Connecting to DevRev Computer (custom MCP connector)

OrderDesk runs an **MCP server** (Model Context Protocol) at `POST /mcp`, in the same process as the app.
DevRev Computer connects to it as a *custom MCP connector* and calls these tools **live** whenever you ask
about orders or sales performance. Nothing is copied into DevRev.

| Tool | What it does |
|---|---|
| `search_orders` | Find orders by free text, status, customer, product, sales rep, region or minimum quantity |
| `get_order` | One order by ID, with value and sales rep |
| `get_order_insights` | Plain-language summary: totals, booked value, open orders, largest order, top rep |
| `get_sales_performance` | Team, rep and region results vs quota over N days, compared with the previous N days |
| `find_stale_orders` | Open orders (New/Processing) with no update for N hours |
| `update_order_status` | Change an order's status. Only exposed when `MCP_ALLOW_WRITES=true` |

**Transport:** Streamable HTTP, stateless, with JSON responses. It's built on the official
`@modelcontextprotocol/sdk`.

### Connect it to Computer
1. **Give the MCP endpoint a public HTTPS URL.**
   - Computer runs in DevRev's cloud, so it can't reach `localhost`.
   - Set `MCP_PORT=4100` in `.env` and the server also listens on `localhost:4100`, serving **only** `/mcp`.
   - Point the tunnel there: `cloudflared tunnel --url http://localhost:4100`. The web app and REST API
     on `PORT` stay private.
   - Don't tunnel the main port: the REST API has no auth.
2. **Protect it.**
   - Set `MCP_API_KEY` in `.env` before exposing it.
   - The server accepts the key as `Authorization: Bearer <key>` or in the URL as `?key=<key>`. Use the
     URL form when the connector can't send your header, or sends its own.
   - Status updates stay off unless you set `MCP_ALLOW_WRITES=true`.
3. **In Computer**, open Settings → Connectors → **Add custom connector** → *Connect custom MCP* and fill in:
   - **Server name:** `OrderDesk`
   - **Server URL:** `https://<your-public-host>/mcp?key=<MCP_API_KEY>`
   - **Server slug:** `orderdesk`
   - **Server description:** `Live field sales order data from OrderDesk: orders, reps, quota attainment, stale orders.`
   - **Select service:** `DevRev`. The form requires a service, and there's no generic option.
     DevRev then verifies the token field against its own API, so completing the connection needs a
     DevRev Personal Access Token.
4. **Try it.** Ask Computer:
   - *"How is the team tracking against quota this month?"*
   - *"Which reps are below 50% attainment?"*
   - *"Show Priya's orders still processing"*
   - *"Any open orders with no update in 2 days?"*

Test locally with any MCP client, e.g. `npx @modelcontextprotocol/inspector` → Streamable HTTP →
`http://localhost:3000/mcp`.

---

## Connecting to DevRev (custom-object sync)

As an alternative to the live MCP connector, OrderDesk can copy its orders into a DevRev org as a
**custom object** named *Order*, with display IDs like `C-ORD-1`. You can then list, filter and search
orders inside DevRev, next to accounts and tickets.

### How it works
- **One-way sync, OrderDesk → DevRev.** The local database stays the source of truth.
- **Built on DevRev's public REST API:** `schemas.custom.set` and `custom-objects.create` / `update` /
  `delete` / `list`, authenticated with a Personal Access Token.
- **Automatic.** After every create, update or delete in OrderDesk, the server syncs that order in the
  background. If DevRev is slow or unreachable, OrderDesk keeps working and logs the error.
- **No duplicates.** Changes to the same order are queued and applied in order. Each DevRev object also
  carries `unique_key: orderdesk-order-<id>`.
- **Full reconcile on demand.** `npm run devrev:sync` creates missing orders, updates existing ones, and
  deletes DevRev orders that no longer exist locally.

### Field mapping

| OrderDesk | DevRev custom field | DevRev type |
|---|---|---|
| `id` | `tnt__order_id` | int |
| `customer_name` | `tnt__customer_name` | tokens |
| `product` | `tnt__product` | tokens |
| `quantity` | `tnt__quantity` | int |
| `status` | `tnt__status` | enum (New, Processing, Shipped, Delivered, Cancelled) |
| `total` | `tnt__order_value` | double |
| `rep_name` | `tnt__sales_rep` | tokens |
| `rep_region` | `tnt__region` | tokens |
| `placed_offline` | `tnt__placed_offline` | bool |
| `created_at` | `tnt__created_at` | timestamp |
| `updated_at` | `tnt__updated_at` | timestamp |

Each object's title reads like `Order #42: 3 × POS Terminal (Acme Retail)`.

### Setup

1. **Create a token.** In DevRev, go to Settings → Account → Personal Access Token → **New token**.
2. **Save it locally.** Run `cp .env.example .env`, then set `DEVREV_PAT=<your token>` in `.env`.
   `.env` is gitignored.
3. **Create the Order object type:** `npm run devrev:setup`
4. **Grant access in DevRev** under Settings → User Management → Roles. Custom objects are visible to
   no one by default.
5. **Push existing orders:** `npm run devrev:sync`
6. **Start the app:** `npm start`. From now on, changes sync automatically. Check progress at
   `GET /api/devrev/status`.

To preview any step without sending anything, add `-- --dry-run`, e.g. `npm run devrev:sync -- --dry-run`.
If the leaf type `order` is unavailable in your org, set `DEVREV_LEAF_TYPE` in `.env`.

---

## How an AI or CRM system like DevRev could use this data

Orders tied to reps, regions, value and timestamps are exactly the operational signal that becomes
valuable next to customer, support and product data.

**1. Customer 360 and account health**
Each order maps to an account in the CRM. Order history, value and fulfilment state appear next to open
tickets and conversations, so support and success teams can answer "what did they buy, who sold it, and
where is it?" in one place.

**2. Proactive support from status and timestamps**
- **Stale orders:** an order stuck in `Processing` past an SLA (the "Needs attention" list) can
  automatically open a ticket for the ops team, assigned with the rep in the loop.
- **Product issues:** a spike in `Cancelled` orders for one product can surface as an issue on that part
  of the product.
- **Large orders:** big orders can alert the account owner before delivery.

**3. AI agents for reps and leaders**
- **Leaders** can ask an agent *"which reps are behind pace?"* and get an answer grounded in
  `get_sales_performance`.
- **Reps** can ask *"what should I follow up on today?"* (`find_stale_orders` filtered to them).
- **Customers** can ask a support agent *"where's my order?"* (`get_order`), and it escalates with full
  context when the answer is overdue or cancelled.

**4. Richer summaries and forecasting**
The dashboard endpoints already return structured aggregates:
- revenue vs the previous period
- attainment by rep and region
- pipeline by stage

An LLM can turn these into weekly sales digests, account briefings or quota-risk alerts, with every number
still coming from the database.

**5. Offline-first field sales (the Offline Mode spec)**
- **Measured offline capture:** `placed_offline` records how orders were captured, so leadership can see
  how much business happens without signal ("Captured offline" KPI).
- **Stable ids:** never-reused ids keep a record's identity consistent across devices and systems.
- **Incremental sync:** `updated_at` on every write supports "give me everything changed since T" and
  last-write-wins conflict detection.
- **Fewer conflicts:** a partial `PUT` lets a reconnecting device replay only the fields a rep changed.

**What a production version would add**

| Gap | Why it matters |
|---|---|
| Real authentication + roles (rep sees own orders, leader sees team) | The mock login is demo flow only |
| `customer_id` foreign key and an accounts table | Reliable account matching in a CRM |
| `order_events` status-history table | Time-in-stage, SLA tracking and AI reasoning over history |
| `GET /api/orders?updated_since=…` + pagination | Efficient incremental sync for devices and agents |
| Webhooks on create/update/delete | Push events into the CRM instead of polling |
| Money in integer cents + currency | Exact arithmetic and multi-currency teams |
| Idempotency keys on `POST` | Safe retries when an offline device reconnects |

---

## Tests

```bash
npm test          # REST API (both engines), store + migrations, MCP tools, DevRev sync (mock). No network, no browser.
npm run test:ui   # optional: headless Chrome end-to-end (set CHROME_PATH if Chrome isn't in the default macOS location)
```

**Isolation:** every suite starts its own server on a free port with a throwaway database and ignores
your `.env`. Tests never touch your data or call real services.

**What `npm run test:ui` covers:**
- the mock login and both dashboards
- chart tooltips, table views and the date filter
- one-click status changes and creating an order
- the detail view and phone-width layout

---

## Built with AI tooling

This prototype was built with **Claude Code** as a pair programmer, in short iterations:
1. Plan the architecture and data model.
2. Build the store, API and UI against a fixed contract.
3. Verify each step before moving on:
   - scripted REST tests on both storage engines
   - headless-browser tests of the UI with screenshot review
   - MCP client tests
   - a mock DevRev API
   - migration tests on a copy of the real database

Several bugs were caught in that verification loop rather than in the demo.
