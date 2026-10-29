import { useState } from "react";
import { useAddTransaction } from "../../data/queries";
import { Card, Button, Segmented } from "../../ui/components";
import { CategorySelect } from "../../ui/CategoryPill";
import { money, fmtDate } from "../../ui/format";
import type { Account, Category } from "../../domain/types";

type Direction = "out" | "in";

/**
 * Add a transaction by hand, such as cash no bank reports, to any account
 * Spending shows. Stays open after each one, keeping the date and account,
 * so a few receipts can go in one after another.
 */
export function AddTransactionForm({ accounts, categories, today, onClose }: {
  accounts: Account[];
  categories: Category[];
  /** Local ISO date the form starts on. */
  today: string;
  onClose: () => void;
}) {
  const add = useAddTransaction();
  // Spending leaves investment accounts out, so nothing is added to one.
  const offered = accounts.filter((a) => !a.hidden && a.type !== "brokerage");
  // A cash account the owner made is the likely home for cash.
  const start = offered.find((a) => a.type === "cash" && a.source === "manual") ?? offered[0];

  const [posted, setPosted] = useState(today);
  const [payee, setPayee] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<Direction>("out");
  const [accountId, setAccountId] = useState<number | null>(start?.id ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string } | null>(null);

  const cents = Math.round(Math.abs(Number(amount)) * 100);
  const ready = payee.trim() !== "" && Number.isFinite(cents) && cents > 0 && accountId != null && posted !== "";

  function save() {
    if (!ready || accountId == null) return;
    setMessage(null);
    const signed = (direction === "out" ? -cents : cents) / 100;
    add.mutate({
      account_id: accountId, posted, amount: signed, payee: payee.trim(),
      category_id: categoryId, note: note.trim() || null,
    }, {
      onSuccess: () => {
        setMessage({ tone: "pos", text: `Added ${payee.trim()}, ${signed > 0 ? "+" : ""}${money(signed)}, on ${fmtDate(posted)}.` });
        setPayee(""); setAmount(""); setNote(""); setCategoryId(null);
      },
      onError: (e) => setMessage({ tone: "neg", text: String(e) }),
    });
  }

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") save(); };

  return (
    <Card title="Add a transaction" subtitle="For cash, or anything your bank doesn't report. Bank syncs and Copilot imports leave it alone."
      actions={<Button variant="ghost" size="sm" onClick={onClose}>Done</Button>}>
      {offered.length === 0 ? (
        <p className="muted">There's no account to add it to. Add a Cash account in Accounts first.</p>
      ) : (
        <div className="grid" style={{ gap: 10 }}>
          <div className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
            <input type="date" value={posted} onChange={(e) => setPosted(e.target.value)} aria-label="Date" style={{ width: 150 }} />
            <input value={payee} onChange={(e) => setPayee(e.target.value)} onKeyDown={onEnter}
              placeholder="Paid to or from" aria-label="Paid to or from" style={{ flex: 1, minWidth: 160 }} autoFocus />
            <Segmented<Direction> value={direction} onChange={setDirection} items={[
              { value: "out", label: "Money out" }, { value: "in", label: "Money in" },
            ]} />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={onEnter}
              inputMode="decimal" placeholder="0.00" aria-label="Amount" style={{ width: 96 }} />
          </div>
          <div className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
            <select value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))} aria-label="Account"
              style={{ width: 220 }}>
              {offered.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} aria-label="Category" />
            <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={onEnter}
              placeholder="Note (optional)" aria-label="Note" style={{ flex: 1, minWidth: 140 }} />
            <Button onClick={save} loading={add.isPending} disabled={!ready}>Add</Button>
          </div>
          {message && <div className={`notice ${message.tone}`}>{message.text}</div>}
        </div>
      )}
    </Card>
  );
}
