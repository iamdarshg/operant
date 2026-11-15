# Design brief: Azaris (azaris.ai) — reusable interaction principles

Source: <https://azaris.ai/>, <https://azaris.ai/integrations>, <https://azaris.ai/docs>
Fetched: 2026-11-15. Read-only research; nothing installed or implemented.

## Evidence caveat (read first)

The three pages returned **full marketing copy, product mockups rendered as text, and mock data** — not an empty JS shell. So claims below about *structure, copy, and mock composition* are observed. What was **NOT observable** (no CSS, fonts, or screenshots were returned by text extraction):

- typefaces, weight/size scale, letterspacing, colour values, spacing tokens, grid
- motion, transitions, hover/focus states
- the real authenticated app (`/meet` is a signup wall): actual dashboard density, real approval-card treatment, real typography
- whether the numbers shown (`41 threads`, `$29,500 recovered`, `1,847 unread`) are real data or illustrative mock data — assume the latter

Anything below about visual density, typography strategy, and "how approvals are presented" is therefore **inferred from copy structure and mock descriptions**, and is flagged where it is inference.

## What the site actually shows

### Information hierarchy

`/` runs a single narrative spine, in this order:

1. Nav (6 items + `Sign in` / `Start free trial`), repeated in a second mobile header block
2. Hero: H1 **"Stop doing what you can delegate."** → one sentence → one CTA → price line inline ("Free for 3 days, then $97/mo") → "1,000+ tools" claim → **a workspace mock**
3. "From the founder" (VSL poster, `azaris-vsl-poster.jpg` — no transcript)
4. Problem section: **"Everything waits on you."** — four named failure modes, each with a micro-mock and a one-line caption
5. "How you get set up" — exactly three numbered steps, each with a panel
6. "It lives where your team already works" — four tool/use-case cards, each with three ✓ lines, plus two deep product panels
7. Pricing (two cards)
8. Footer (8 links + one-line positioning)

Pattern: **problem → three-step setup → capability cards → deep mock → price**. The product mock appears *three* times at different zoom levels (workspace snapshot, single conversation, use-case panel), never as a generic screenshot hero.

### How a request is delegated

Observed, in the hero mock and the integrations page:

- A human message in the user's own channel: *"I'm buried. Go through the weekend inbox and draft replies to whatever's easy."* (8:14)
- The agent answers 2 minutes later with **outcome first, then a count triple**: *"Done. 41 threads: 28 are noise, 9 replies are drafted, 4 need you. Shortlist's below."*
- The same shape repeats on the integrations page with `@Azaris onboard Acme Health. Set up the project, schedule kickoff, send the welcome email, and alert the delivery team.` → *"Done. The project is live in Asana, kickoff is on the calendar, …"*

Delegation is **one sentence of intent, not a form**; the response is **a completed-state claim plus the residual that needs a human**. Scope, tools and permissions are chosen once at setup, not per request.

### How background work is surfaced

Observed: the hero mock is an **"Inbox"** whose rows are *agents*, not emails:

| Row | Time |
| --- | --- |
| Milo: 9 drafts ready for you… | Fri |
| Morning brief — Dawn: On your desk: 3 things… | 7:02 |
| Research — Scout: Competitor diff is in… | Fri |
| Invoices — Ledger: $48,200 out, three pas… | Thu |
| Suppliers — **You**: confirmed for Tuesday | Thu |
| Calendar — Remy: Thursday clash fixed… | Wed |

Each row = `agent: deliverable state…` + recency, and human-authored rows are marked **"You:"** in the same stream. Setup step 2 names the mechanism: *"Azaris learns your business … stays connected across every tool"*, and pricing lists *"cloud browser and persistent memory included"*. So background work is surfaced as **a continuously-filled results ledger**, not as a progress bar or a job log.

### How approvals are presented

Three separate surfaces, all textual:

1. **Inside the answer, as a clause**: *"I drafted a budget shift that moves $300/day to the winner and left it waiting for your approval."*
2. **As a per-row status in a review queue**: `needs approval` sits in the same status column as `follow-up sent, paid` and `payment date confirmed`.
3. **Named as a product feature at the price tier**: *"Approval cards: your agent checks with you before big decisions."*

Pattern: the approval is **an item in the work list with a status**, and the agent states plainly what it did *not* do. Whether "approval card" is a modal, a card, or an inline row is **not verifiable** — the phrase only appears in a pricing bullet.

### How connected tools/integrations are shown

- **Proof chips under an answer**: tool logo + verb phrase of the act — `gmail` "9 replies drafted", `googlecalendar` "Double-booking flagged", `notion` "Shortlist filed". Same device on the ads answer: `facebook` 18 active ad sets, `hubspot` 18 booked calls, `google_analytics` 1,284 sessions, `stripe` 6 new customers.
- **Setup panel counts**: "**5** of 5 connected · **4,514** records read", with a permission label `Read access` at the panel head and per-tool depth: Gmail "2,513 threads read · Connected", iMessage "860 texts read", Google Calendar "139 jobs mapped", QuickBooks "2,102 invoices read", Meta Ads "18 ad sets analyzed".
- **Directory, category-first**: Channels / Work & docs / Product & code / Money & sales / Meetings & content, ~6 items visible each, under "A few of the 1,000+".
- **Three escalating capability tiers**, honestly ranked: *a native connector* ("a click to add, scopes you choose, disconnect anytime") → *through the catalog* ("the long tail: 1,000+ tools") → *its own browser* ("if it has a website, your agent can drive it … the way a person would").
- **Specialists, not generalists**: each agent card carries a role label (`MARKETING · ANALYTICS`, `DEV · ISSUES`, `EMAIL · COMMS`, `FINANCE · CRM`), a human operator name (Priya, Sam, Omar, Maya), and "+ its full stack" after the named chips.

### Visual density (inferred)

Inference, from copy-and-mock structure only: the marketing page is **low-density and long** (one idea per band, one mock per band, ~70–90 words of copy per section). The *product* mocks are **high-density** — a 10-row table with 5 columns, two-list panels, 6-row activity streams. That contrast is deliberate: sell with air, then prove with a dense artifact. Real dashboard density: unverified.

### Typography strategy (inferred)

No fonts were returned. Observable proxy: the copy uses **sentence-case headings that are full sentences ending in a period** ("Your systems don't talk to each other. Every handoff runs through you." / "Connected tonight. A report by morning." / "Now hand it to Azaris."), heavy use of **bold for the single load-bearing phrase inside a bullet** ("Flags spend **drifting past target**"), and **status words in sentence case** ("Connected", "needs approval", "warm"). No tracked caps except role labels on agent cards (`MARKETING · ANALYTICS`). Any claim about typefaces or a type scale would be invented — do not carry one forward.

### Navigation model

Marketing nav is flat, 6 items, no dropdowns in the extracted text, with the two CTAs always present and the whole nav duplicated in a second header block. Docs use a **left rail with five groups** (Learn / Tutorials / Compare / Support) — 7 Learn pages, 7 tutorials, **8 "Azaris vs X" comparison pages**, FAQ. In-product navigation is unverifiable; docs describe delegation through Slack / Discord / Telegram / voice instead of through an app nav, i.e. **the UI is deliberately outside the product**.

### Status presentation

A small closed vocabulary reused everywhere: `Connected` · `read` / `mapped` / `analyzed` · `selected` / `reduce` / `hold` / `updated` · `moved forward automatically` / `waiting for your approval` / `needs approval` · `paid` / `confirmed` / `sent`. Two colours implied by wording, never by CSS: **done** vs **owed**.

### Product voice

Second person, short declaratives, no exclamation marks, no "supercharge/unleash". Recurring guarantee in three places (hero sub, price bullet, footer): *"does the work and **checks with you before big decisions**"*. Headings make a claim and stop. Failure modes are stated in the customer's units ("$48k cooling in the pipeline", "Focus block: gone by 9:10"), not as adjectives.

## Concrete patterns worth reusing

1. **One inbox, many employees.** The primary surface is a results ledger where each row is `agent · deliverable · when`, and human actions are rows too (`You: confirmed for Tuesday`). Compose the row as *state*, not as a task title.
2. **Outcome-first reply with a count triple.** `Done. <total> <unit>: <noise> …, <done> …, <n> need you.` One line, three numbers, last one is the human's residual.
3. **Evidence chips under every claim.** Tool logo (or initials) + a verb phrase naming the act, one per tool touched, max 3–4, then `+ its full stack`. Proof trails the sentence that made the claim.
4. **Approvals live in the work list.** Pending human decisions are rows with a status (`needs approval`), not a separate modal queue; the agent's prose also names what it did not do. Risk if copied naively: an approval row can be scrolled past — pair it with a persistent count.
5. **Verdict before table.** Every dense panel opens with a sentence that states the decision ("Retargeting is winning", "8 budget updates selected") and closes with a reconciliation sentence that accounts for every row ("Five are ready to scale, three are marked to reduce, and two stay on watch").
6. **Change ledger, not diff.** Per row: `~~before~~ **after**` + a ≤8-word reason ("high impressions, weak click-through"). Aggregate the outcome once, at the foot ("+1,860 organic visits a month").
7. **Capability claims as detect → prepare → commit-after-approval triples.** "Flags spend drifting past target / Selects campaigns ready to scale / Updates the plan after approval." This makes the autonomy boundary legible in three lines.
8. **Three honest integration tiers.** Native connector / catalog / agent-driven browser — each labelled with what it costs the user (scopes, click count, reliability). Never present the long tail as if it were native.
9. **Setup as three numbered steps with counters, promising a time-to-value.** "Connect your stack (5 of 5, 4,514 records read)" → "learns your business" → "delegate where you already work", headlined "Connected tonight. A report by morning."
10. **Money and time as the metrics.** `$29,500 recovered this month`, `$42 per booked call`, `2× booked`. The single metric per panel is the one the customer would quote.
11. **A closed status vocabulary** with two registers (done / owed) used identically in lists, chips, and prose.
12. **Voice: sentences with periods, one bold phrase per bullet, no exclamation marks**, and the same guarantee repeated verbatim at hero, price and footer.

## Anti-patterns observed (do not copy)

- **The Ads Manager panel's arithmetic does not reconcile**: "**8** budget updates selected" over a footer that explains "**Five** … ready to scale, **three** … reduce, and **two** stay on watch" (5+3+2 = 10 rows, 8 selected). A dashboard that miscounts its own queue destroys trust in every other number. Any count triple must be computed, never written.
- **Mock data presented with real specificity** (`1,847 unread`, `2,513 threads read`) with no "demo" marker in the extracted text.
- **Nav duplicated** in the markup (two full nav blocks), i.e. one for mobile — fine for marketing, a smell if copied into an app shell.
- **Testimonial-free** throughout: there are no quotes, logos of customers, or case-study counts. That is honest, but it also means the page has **no third-party proof** — a gap worth filling deliberately in a real product, with real names.

## Explicitly unverified

- fonts, colours, spacing, radii, motion, focus states (no CSS fetched)
- the authenticated dashboard: layout, density, approval component, empty/error states
- whether "cloud browser" and "persistent memory" map to a visible UI surface
- video content ("From the founder", tutorials) — poster image only
- any performance, accessibility or responsive behaviour