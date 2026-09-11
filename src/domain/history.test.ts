import { describe, it, expect } from "vitest";
import { reconstructSeries, type PriceRow } from "./history";
import type { Account, BankTransaction, SyncedHolding, Transaction } from "./types";

function acct(id: number, name: string, type: Account["type"], source: Account["source"],
              balance: number | null, hidden = false): Account {
  return {
    id, name, type, institution: null, currency: "USD", created_at: "",
    source, external_id: source === "simplefin" ? `x${id}` : null,
    synced_balance: balance, last_synced_at: null, hidden,
  };
}
function price(security_id: number, date: string, close: number): PriceRow {
  return { security_id, date, close };
}
function bank(id: number, account_id: number, posted: string, amount: number): BankTransaction {
  return {
    id, account_id, external_id: `e${id}`, posted, amount, description: "x",
    payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto",
  };
}

const TODAY = "2026-09-05";
const base = { today: TODAY, days: 90 };

describe("reconstructSeries — manual accounts", () => {
  const brokerage = acct(1, "Brokerage", "brokerage", "manual", null);
  // Deposit 1000 on the 1st, buy 2 shares at 100 on the 3rd.
  const txns: Transaction[] = [
    { id: 1, account_id: 1, security_id: 10, type: "deposit", date: "2026-09-01",
      quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
    { id: 2, account_id: 1, security_id: 10, type: "buy", date: "2026-09-03",
      quantity: 2, price: 100, amount: 200, fees: 0, note: null },
  ];
  const prices = [
    price(10, "2026-09-01", 100), price(10, "2026-09-03", 100), price(10, "2026-09-05", 150),
  ];

  it("values a day before the buy as cash only", () => {
    const s = reconstructSeries({ ...base, accounts: [brokerage], txns, synced: [], bankTxns: [], prices });
    expect(s.find((p) => p.date === "2026-09-01")?.value).toBe(1000);
  });

  it("moves the shares out of cash and into holdings on the day of the buy", () => {
    const s = reconstructSeries({ ...base, accounts: [brokerage], txns, synced: [], bankTxns: [], prices });
    // 800 cash left + 2 shares at 100 = 1000, unchanged on the day.
    expect(s.find((p) => p.date === "2026-09-03")?.value).toBe(1000);
  });

  it("follows the price after the buy", () => {
    const s = reconstructSeries({ ...base, accounts: [brokerage], txns, synced: [], bankTxns: [], prices });
    // 800 cash + 2 shares at 150 = 1100.
    expect(s.find((p) => p.date === "2026-09-05")?.value).toBe(1100);
  });

  it("never shows a position that was later deleted, because it reads the transactions", () => {
    const s = reconstructSeries({ ...base, accounts: [brokerage], txns: [], synced: [], bankTxns: [], prices });
    expect(s.every((p) => p.value === 0)).toBe(true);
  });
});

describe("reconstructSeries — synced accounts", () => {
  const broker = acct(1, "Fidelity", "brokerage", "simplefin", 600);
  const held: SyncedHolding[] = [
    { id: 1, account_id: 1, security_id: 10, shares: 4, cost_basis: 400, market_value: 600, as_of: TODAY },
  ];
  const prices = [price(10, "2026-09-04", 100), price(10, TODAY, 150)];

  it("values today's shares at each day's price", () => {
    const s = reconstructSeries({ ...base, accounts: [broker], txns: [], synced: held, bankTxns: [], prices });
    expect(s.find((p) => p.date === "2026-09-04")?.value).toBe(400);
    expect(s.find((p) => p.date === TODAY)?.value).toBe(600);
  });

  // The balance SimpleFIN reports for a brokerage already contains the
  // holdings, so adding both put the whole invested amount in twice.
  it("does not add a brokerage's holdings on top of its balance", () => {
    const invested = acct(1, "Fidelity", "brokerage", "simplefin", 600);
    const s = reconstructSeries({ ...base, accounts: [invested], txns: [], synced: held, bankTxns: [], prices });
    expect(s.find((p) => p.date === TODAY)?.value).toBe(600);
  });

  it("keeps the uninvested part of a brokerage balance", () => {
    const withCash = acct(1, "Fidelity", "brokerage", "simplefin", 750);
    const s = reconstructSeries({ ...base, accounts: [withCash], txns: [], synced: held, bankTxns: [], prices });
    // 600 of holdings plus the 150 sitting uninvested.
    expect(s.find((p) => p.date === TODAY)?.value).toBe(750);
  });
});

describe("reconstructSeries — reconstructed cash", () => {
  const current = acct(2, "Everyday", "cash", "simplefin", 500);
  const card = acct(3, "Card", "credit", "simplefin", -200);
  const prices = [price(10, "2026-09-04", 100), price(10, TODAY, 100)];

  it("walks a cash balance backwards through its transactions", () => {
    // Balance is 500 today; 80 was spent on the 5th, so the 4th closed at 580.
    const s = reconstructSeries({
      ...base, accounts: [current], txns: [], synced: [],
      bankTxns: [bank(1, 2, TODAY, -80)], prices,
    });
    expect(s.find((p) => p.date === "2026-09-04")?.value).toBe(580);
    expect(s.find((p) => p.date === TODAY)?.value).toBe(500);
  });

  it("counts a card balance as money owed", () => {
    const s = reconstructSeries({ ...base, accounts: [card], txns: [], synced: [], bankTxns: [], prices });
    expect(s.find((p) => p.date === TODAY)?.value).toBe(-200);
  });

  it("ignores a transaction posted on or before the date being valued", () => {
    // A charge on the 4th is already in the 4th's closing balance.
    const s = reconstructSeries({
      ...base, accounts: [current], txns: [], synced: [],
      bankTxns: [bank(1, 2, "2026-09-04", -80)], prices,
    });
    expect(s.find((p) => p.date === "2026-09-04")?.value).toBe(500);
  });
});

describe("reconstructSeries — what it refuses to guess", () => {
  const broker = acct(1, "Fidelity", "brokerage", "simplefin", 600);
  const held: SyncedHolding[] = [
    { id: 1, account_id: 1, security_id: 10, shares: 4, cost_basis: 400, market_value: 600, as_of: TODAY },
  ];

  it("gives no series at all when there are no prices", () => {
    const s = reconstructSeries({ ...base, accounts: [broker], txns: [], synced: held, bankTxns: [], prices: [] });
    expect(s).toEqual([]);
  });

  it("starts only once every holding has a price, rather than showing a false dip", () => {
    const twoHoldings: SyncedHolding[] = [
      ...held,
      { id: 2, account_id: 1, security_id: 11, shares: 1, cost_basis: 10, market_value: 10, as_of: TODAY },
    ];
    const prices = [
      price(10, "2026-09-01", 100), price(10, TODAY, 100),
      price(11, TODAY, 50), // only priced from today
    ];
    // The balance covers both holdings, so it grows with the second one.
    const bothHeld = acct(1, "Fidelity", "brokerage", "simplefin", 610);
    const s = reconstructSeries({ ...base, accounts: [bothHeld], txns: [], synced: twoHoldings, bankTxns: [], prices });
    expect(s.map((p) => p.date)).toEqual([TODAY]);
    expect(s[0].value).toBe(450);
  });

  it("carries the last known close forward over a day with no trading", () => {
    const prices = [price(10, "2026-09-01", 100), price(10, "2026-09-04", 100), price(10, TODAY, 100)];
    const s = reconstructSeries({ ...base, accounts: [broker], txns: [], synced: held, bankTxns: [], prices });
    expect(s).toHaveLength(3);
    expect(s.every((p) => p.value === 400)).toBe(true);
  });

  it("leaves hidden accounts out entirely", () => {
    const hiddenBroker = acct(1, "Fidelity", "brokerage", "simplefin", 600, true);
    const prices = [price(10, TODAY, 150)];
    const s = reconstructSeries({ ...base, accounts: [hiddenBroker], txns: [], synced: held, bankTxns: [], prices });
    expect(s.find((p) => p.date === TODAY)?.value).toBe(0);
  });

  it("stops at the edge of the window", () => {
    const prices = [price(10, "2026-01-01", 100), price(10, TODAY, 100)];
    const s = reconstructSeries({ ...base, days: 30, accounts: [broker], txns: [], synced: held, bankTxns: [], prices });
    expect(s.map((p) => p.date)).toEqual([TODAY]);
  });

  it("returns points in date order", () => {
    const prices = [price(10, TODAY, 100), price(10, "2026-09-01", 100), price(10, "2026-09-03", 100)];
    const s = reconstructSeries({ ...base, accounts: [broker], txns: [], synced: held, bankTxns: [], prices });
    expect(s.map((p) => p.date)).toEqual(["2026-09-01", "2026-09-03", TODAY]);
  });
});

describe("reconstructSeries — securities Yahoo has never priced", () => {
  const broker = acct(1, "Fidelity", "brokerage", "simplefin", 900);
  // A money-market fund or obscure mutual fund: SimpleFIN knows its value,
  // Yahoo has never heard of the ticker, so there are no price rows at all.
  const unpriceable: SyncedHolding = {
    id: 2, account_id: 1, security_id: 99, shares: 1, cost_basis: 300, market_value: 300, as_of: TODAY,
  };
  const priced: SyncedHolding = {
    id: 1, account_id: 1, security_id: 10, shares: 4, cost_basis: 400, market_value: 600, as_of: TODAY,
  };
  const prices = [price(10, "2026-09-04", 100), price(10, TODAY, 150)];

  it("still draws a chart instead of blanking it entirely", () => {
    const s = reconstructSeries({
      ...base, accounts: [broker], txns: [], synced: [priced, unpriceable], bankTxns: [], prices,
    });
    expect(s.map((p) => p.date)).toEqual(["2026-09-04", TODAY]);
  });

  it("holds an unpriceable holding flat at the value the bank reported", () => {
    const s = reconstructSeries({
      ...base, accounts: [broker], txns: [], synced: [priced, unpriceable], bankTxns: [], prices,
    });
    expect(s.find((p) => p.date === "2026-09-04")?.value).toBe(400 + 300);
    expect(s.find((p) => p.date === TODAY)?.value).toBe(600 + 300);
  });

  it("still waits for a security whose history simply starts later", () => {
    // This one has prices, just not yet on the 4th, so that date is not valuable.
    const late: SyncedHolding = {
      id: 3, account_id: 1, security_id: 11, shares: 1, cost_basis: 10, market_value: 50, as_of: TODAY,
    };
    const s = reconstructSeries({
      ...base, accounts: [broker], txns: [], synced: [priced, late], bankTxns: [],
      prices: [...prices, price(11, TODAY, 50)],
    });
    expect(s.map((p) => p.date)).toEqual([TODAY]);
  });
});
