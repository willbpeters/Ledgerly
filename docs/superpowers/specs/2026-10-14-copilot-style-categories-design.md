# Copilot-style categories and review

**Date:** 2026-10-14
**Status:** design agreed, not yet implemented
**Replaces:** stages 2 and 3 of `2026-09-12-bank-supplied-categories-design.md`

## What the data showed

The SimpleFIN diagnostic, extended on 2026-10-14 to count every field across
all transactions in the window, scanned **157 transactions** over 44 days on the
owner's real connections (Chase, Bank of America, Robinhood, Schwab). Every one
carried exactly `amount`, `description`, `id`, `memo`, `payee`, `posted` and
`transacted_at`. **No `extra`, no category, and `mcc` null on all of them.**

So the bank-category design is dead, as its own stage 1 anticipated: there is
nothing to read. And the existing merchant-code map does nothing for this
owner either. In the database, 260 of 373 bank transactions are uncategorised
and the other 113 are "Income" only because the amount was positive — which
also mislabels a credit-card payment arriving on the card as income.

What SimpleFIN *does* send is a clean `payee`: "Target", "Costco",
"Chick-fil-A", "Chase Credit Card", "Robinhood Money". That is the signal this
design builds on.

## Goal

Behave like Copilot: transactions arrive already sorted where Ledgerly can tell,
every new one waits in a **To review** list, and fixing one teaches Ledgerly the
payee for next time.

## Decisions taken with the owner

1. **Transfers are recognised automatically** — matched pairs between the
   owner's own accounts, plus clear transfer wording.
2. **Money sent to people is not a transfer.** "Transfer to Apple Pay",
   Venmo, Zelle, Cash App and PayPal are left uncategorised for the owner to
   decide (a split dinner is Dining, rent is Rent).
3. **Investment accounts are kept out of Spending and budgets**, as Copilot
   does. Their transactions still appear in Activity.
4. **When this ships, only transactions still uncategorised land in To review.**
   Everything that the re-sort manages to categorise starts out reviewed.

## The ladder

`budget/categorize.rs::decide()` becomes, first match wins:

1. User rules: MCC, then payee, then description (unchanged).
2. **Person-to-person wording** (`p2p` list) → *no category*. Checked before
   anything that could call it a transfer or a purchase.
3. **Transfer wording** (`transfers` list) → **Transfer**.
4. The merchant-code map (unchanged; harmless when `mcc` is absent).
5. **Known merchant** (`merchants` list) → that category.
6. **Merchant keyword** (`keywords` list) → that category.
7. Money in on a **cash** account → **Income**. Money in on a **credit** account
   is a refund or a payment, not income, and gets no category from this rung.
8. Otherwise no category.

`Candidate` gains `account_type: String` for rung 7.

A **manual** category is still never re-decided, as today. Every sync keeps
re-deciding `'auto'` rows in its window, so improvements to the lists reach
recent history without any special step.

### Matching

Payee and description are normalised before matching: lower-cased, apostrophes
and punctuation removed, runs of spaces collapsed ("Trader Joe's" →
"trader joes"). The merchant list matches a **whole word sequence** within the
payee, so "target" matches "Target" and "Target T-1234" but not "Targeted Ads".
Keywords match whole words in the payee, then the description.

### The lists (`budget/merchants.rs`, pure)

Seeded from the owner's own top payees and common US chains, mapped onto the
fifteen built-in categories. Illustrative, not exhaustive:

| Category | Examples |
|---|---|
| Groceries | Trader Joe's, Costco, Safeway, Whole Foods, Kroger, Aldi, Walmart Grocery |
| Dining | Chick-fil-A, In-N-Out, Taco Bell, Panda Express, Raising Cane's, Starbucks, McDonald's, Chipotle, Menchie's, DoorDash, Uber Eats |
| Shopping | Target, Amazon, Walmart, Best Buy, Home Depot, Lowe's |
| Transport | Uber, Lyft, parking, tolls |
| Fuel | Shell, Chevron, Arco, 76, Exxon |
| Travel | Allegiant Air, Southwest, Delta, United, Alaska Airlines, Airbnb, Marriott, Hilton |
| Subscriptions | Spotify, Netflix, Hulu, Disney+, YouTube Premium, Apple (subscriptions), Anthropic, OpenAI |
| Utilities | PG&E, SMUD, Comcast, Xfinity, AT&T, Verizon, T-Mobile |
| Health | CVS, Walgreens, Kaiser |
| Entertainment | AMC, Regal, Steam, golf (keyword) |
| Fees | "fee", "interest charge" (keywords) |
| Shopping (fallback keyword) | "store", "shop" |

Keywords: "burger", "taco", "pizza", "grill", "cafe", "coffee", "restaurant" →
Dining; "airline", "air", "hotel", "inn" → Travel (only as whole words);
"golf" → Entertainment; "fee" → Fees.

Ambiguous merchants (Costco, Apple, Amazon) get the owner's most likely use;
the review step and payee rules exist precisely to correct them once.

**Transfer wording:** "credit card payment", "card payment", "automatic
payment", "autopay", "payment thank you", "credit crd", "transfer to
checking", "transfer to savings", "transfer from", "online transfer"; a payee
that is exactly "Payment" or "Gold Payment" (how the Robinhood card and Gold
card label a payment received); and own-account brokerages as a whole payee:
Robinhood, Robinhood Money, Fidelity, Schwab, Vanguard. Checked against the
owner's data on 2026-10-14: every "Robinhood" row there is a card payment or a
move between their own accounts.

**Person-to-person wording:** "apple pay", "apple cash", "venmo", "zelle",
"cash app", "paypal".

## Transfer pairs (`budget/transfers.rs`, pure)

After every sync (and in the one-time re-sort), a pass pairs transactions:

- one negative and one positive, **equal to the cent** in size,
- in **different** accounts that are both the owner's,
- posted **within 5 days** of each other,
- both `'auto'`, and neither matching the person-to-person list.

Each transaction joins at most one pair; candidates are matched closest date
first. Both sides become **Transfer**. This catches "Chase Credit Card
−$40.59" on Bank of America against "Automatic Payment +$40.59" on Chase, and
Savings → Robinhood moves, even where the wording says nothing.

The pure function takes `(id, account_id, posted, amount, is_p2p)` rows and
returns the ids to mark; `store.rs` does the I/O. The pass looks at rows from
the last 60 days, so its cost stays flat as history grows.

## Review

**Schema v6:** `bank_transactions.reviewed INTEGER NOT NULL DEFAULT 0`, added
through `add_column_if_missing`, with `v6_is_complete` and an entry in
`db::migration_pending`, applied after the v5 block, per the `db.rs` rules.

The v6 block runs inside one SQLite transaction:

1. add the column;
2. **re-sort every `'auto'` row** with the new ladder and the pair pass (all
   inputs — payee, description, amount, account type — are already stored, so
   no network is needed);
3. set `reviewed = 1` wherever a category is now set (decision 4).

Being one transaction, an interruption leaves either the old schema or the
finished one, never a column with nothing marked. The launch backup labels
itself `pre-migration` before any of it runs.

From then on:

- **New rows arrive with `reviewed = 0`**, whatever their category.
- **Choosing a category marks the row reviewed** (and manual, as today).
- **Approving** (✓) marks it reviewed and sets `category_source = 'manual'`, so
  a later list change can never silently move something the owner accepted.
- **Mark all reviewed** approves every row currently in the list.
- Re-sorting on sync never touches `reviewed`.

New commands: `bank_transactions_to_review` (all unreviewed rows, newest first,
any month), `bank_transaction_approve(id)`, `bank_transactions_approve_all()`.
`bank_transaction_set_category` additionally sets `reviewed = 1`.

## Spending screen

- A **Month / To review (n)** switch at the top. *Month* is today's view. *To
  review* lists every unreviewed transaction across all months, with the same
  inline category picker, a **✓** button per row, and **Mark all reviewed**.
- In the month view, an unreviewed row shows a small dot beside its category.
- The existing "Always use this for <payee>?" offer after a change stays as is;
  it is the "learns from your fixes" half of Copilot.
- **Investment accounts are left out** of spending, income, budgets and the
  review list: transactions whose account type is `brokerage` are filtered in
  `src/domain/spending.ts`, next to the existing hidden-account filter.

The owner's "Crypto (7081)" and "Robinhood individual (7202)" accounts are
typed `cash` today; they need setting to Brokerage in Accounts for the filter
to catch them. The ship notes say so.

## Rules this must not break

1. **A manual category is never overwritten** — by sync, the pair pass, or the
   re-sort.
2. **Person-to-person payments are never auto-filed as transfers**, by wording
   or by pairing.
3. **The v6 migration is one transaction, idempotent, and in
   `migration_pending`** (see the `db.rs` header and HANDOFF gotchas).
4. **An unknown payee stays uncategorised** rather than landing in "Other":
   a wrong guess is worse than an honest blank, because it hides in a budget.
5. **Never use the browser's `confirm()`** in the new UI (`askToConfirm`).

## Testing

- `merchants.rs`: normalisation; whole-word matching (Target vs Targeted);
  each list rung; P2P beats transfer wording; unknown → none.
- `transfers.rs`: a matched pair; amounts a cent apart do not pair; same
  account does not pair; 6 days apart does not pair; each row pairs once,
  closest date first; P2P rows never pair; manual rows never pair.
- `categorize.rs`: the new order — a payee rule beats a known merchant; P2P
  beats transfer wording; a positive amount on a credit account is not Income,
  on a cash account it is; all nine existing tests unchanged.
- Migration: v6 on a populated v5 database re-sorts auto rows, leaves manual
  rows alone, and marks reviewed exactly the categorised ones; running it twice
  changes nothing; `migration_pending` reports a v5 database.
- `store.rs`: a new row arrives unreviewed; setting a category or approving
  marks it reviewed; approve sets manual; a sync re-sort leaves `reviewed`.
- Spending: brokerage transactions are excluded; the review panel lists
  unreviewed rows, approves one, and approves all.

## Out of scope

- Splitting a transaction (TODO item 15) and editing payee names (item 11).
- Fetching merchant data from any paid service.
- Recurring-bill detection (item 12), which will reuse the clean payees.
