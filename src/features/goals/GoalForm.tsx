import { useState } from "react";
import { useCreateGoal, useUpdateGoal } from "../../data/queries";
import { Button, Field } from "../../ui/components";
import type { Account, Goal, NewGoal } from "../../domain/types";

/** The form's fields, as typed. `track` is "" for "by hand", else an account id. */
export interface GoalDraft { name: string; target: string; date: string; track: string; saved: string }

/** "$2,000" and "2000" both mean 2000. */
const amount = (text: string) => Number(text.replace(/[$,\s]/g, ""));

function isRealDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * The form's text as a goal, or the first thing wrong with it. The same rules
 * as `validate` in `commands/goals.rs`, checked here so a mistake is explained
 * beside the form rather than coming back as an error from Rust.
 */
export function readGoal(d: GoalDraft): NewGoal | string {
  if (!d.name.trim()) return "Give the goal a name.";
  const target = amount(d.target);
  if (d.target.trim() === "" || !Number.isFinite(target) || !(target >= 0.01)) return "Set a target of at least $0.01.";
  const date = d.date.trim();
  if (date !== "" && !isRealDay(date)) return "That date isn't a real day.";
  const byHand = d.track === "";
  const saved = d.saved.trim() === "" ? 0 : amount(d.saved);
  if (byHand && !Number.isFinite(saved)) return "Enter how much is saved so far, or leave it blank.";
  if (byHand && saved < 0) return "The amount saved can't be below $0.";
  return {
    name: d.name.trim(),
    target_amount: target,
    target_date: date || null,
    account_id: byHand ? null : Number(d.track),
    // Kept while an account is followed, so switching back to "by hand" finds it again.
    saved_amount: Number.isFinite(saved) && saved >= 0 ? saved : 0,
  };
}

/**
 * Add a goal, or change one. `accounts` are the ones a goal may follow: the
 * caller passes visible cash and brokerage accounts only. `otherAccounts` are
 * visible ones it can't follow (credit cards), so a goal still pointing at one
 * can say what happened to it instead of calling it hidden.
 */
export function GoalForm({ goal, accounts, otherAccounts = [], onDone }: {
  goal?: Goal;
  accounts: Account[];
  otherAccounts?: Account[];
  onDone: () => void;
}) {
  const create = useCreateGoal();
  const update = useUpdateGoal();
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target_amount) : "");
  const [date, setDate] = useState(goal?.target_date ?? "");
  const [track, setTrack] = useState(goal?.account_id == null ? "" : String(goal.account_id));
  const [saved, setSaved] = useState(goal && goal.saved_amount > 0 ? String(goal.saved_amount) : "");
  const [error, setError] = useState<string | null>(null);

  // A goal can follow an account that is now hidden or gone, which is not among
  // `accounts`. Say so, and let its amount be seen and changed, as that amount
  // is what the goal shows while it can't read the account.
  const orphaned = track !== "" && !accounts.some((a) => String(a.id) === track);
  const retyped = orphaned ? otherAccounts.find((a) => String(a.id) === track) : undefined;
  const showSaved = track === "" || orphaned;
  /** Edit a field, and drop an explanation that may no longer apply. */
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setError(null); };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // The amount is checked whenever it is shown, so an orphaned account is read as "by hand" here.
    const read = readGoal({ name, target, date, track: orphaned ? "" : track, saved });
    if (typeof read === "string") {
      setError(read);
      return;
    }
    const checked = orphaned ? { ...read, account_id: Number(track) } : read;
    setError(null);
    const options = { onSuccess: onDone, onError: (err: unknown) => setError(String(err)) };
    if (goal) update.mutate({ id: goal.id, goal: checked }, options);
    else create.mutate(checked, options);
  }

  return (
    <form className="row" onSubmit={submit}>
      <Field label="Name">
        <input value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="Emergency fund" />
      </Field>
      <Field label="Target amount">
        <input value={target} onChange={(e) => edit(setTarget)(e.target.value)} inputMode="decimal" placeholder="10000" style={{ width: 110 }} />
      </Field>
      <Field label="Target date (optional)">
        <input type="date" value={date} onChange={(e) => edit(setDate)(e.target.value)} />
      </Field>
      {date !== "" && (
        <Button type="button" variant="ghost" onClick={() => edit(setDate)("")}>No date</Button>
      )}
      <Field label="Track it with">
        <select value={track} onChange={(e) => edit(setTrack)(e.target.value)}>
          <option value="">I'll update it myself</option>
          {orphaned && <option value={track}>{retyped ? `${retyped.name} (now a credit card)` : "An account you've hidden"}</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      {showSaved && (
        <Field label="Saved so far" hint={orphaned
          ? (retyped ? "This goal shows this amount while it follows a credit card." : "This goal shows this amount while its account is hidden.")
          : undefined}>
          <input value={saved} onChange={(e) => edit(setSaved)(e.target.value)} inputMode="decimal" placeholder="0" style={{ width: 110 }} />
        </Field>
      )}
      <Button type="submit" loading={create.isPending || update.isPending}>{goal ? "Save" : "Add goal"}</Button>
      <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      {error && <span className="field-error" role="alert">{error}</span>}
    </form>
  );
}
