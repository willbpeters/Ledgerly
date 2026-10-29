import { useState } from "react";
import {
  useCategories, useRules, useCreateCategory, useUpdateCategory, useDeleteCategory, useDeleteRule,
  useClearCategories, useSetCategoryKind, useCreateRule,
} from "../../data/queries";
import { Card, Button, EmptyState } from "../../ui/components";
import { CategoryPill, CategorySelect } from "../../ui/CategoryPill";
import { CATEGORY_TOKENS, categoryColour, categoryToken } from "../../ui/categoryColour";
import { askToConfirm } from "../../ui/confirm";
import type { Category, CategoryKind } from "../../domain/types";

// What a category can count as, in the owner's words.
const KINDS: [CategoryKind, string][] = [["spending", "Spending"], ["income", "Income"], ["transfer", "Not counted"]];

// What each of the twelve colours is called in the picker, in token order.
const COLOUR_NAMES = ["Blue", "Orange", "Aqua", "Yellow", "Pink", "Green", "Violet", "Red", "Sky", "Lime", "Plum", "Brown"];

/**
 * A colour picker: the twelve category colours by name, beside a swatch of the
 * one chosen. With `automatic`, it first offers to let Tally pick the
 * least-used colour ("auto"), so new categories look distinct by default.
 */
function ColourPicker({ value, onChange, label, automatic = false }: {
  value: string; onChange: (token: string) => void; label: string; automatic?: boolean;
}) {
  const swatch = value === "auto"
    ? { border: "1px dashed var(--line-2)" }
    : { background: categoryColour(value) };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: "50%", flexShrink: 0, ...swatch }} />
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 104 }} aria-label={label}>
        {automatic && <option value="auto">Automatic</option>}
        {CATEGORY_TOKENS.map((t, i) => <option key={t} value={t}>{COLOUR_NAMES[i]}</option>)}
      </select>
    </span>
  );
}

// What a rule looks at, in the owner's words.
const MATCHES: Record<string, string> = {
  payee: "Payee contains", description: "Description contains", mcc: "Merchant code is",
};

/** Write a rule: text to look for in the payee or the bank's description, and
 *  the category it files into. Saving sorts history at once. */
function RuleForm({ categories }: { categories: Category[] }) {
  const create = useCreateRule();
  const [matchType, setMatchType] = useState<"payee" | "description">("payee");
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string } | null>(null);
  const ready = pattern.trim() !== "" && categoryId != null;

  function save() {
    if (!ready) return;
    setMessage(null);
    create.mutate({ matchType, pattern, categoryId }, {
      onSuccess: (moved) => {
        setPattern("");
        setMessage({ tone: "pos", text: `Rule saved. ${moved} transaction${moved === 1 ? "" : "s"} moved.` });
      },
      onError: (e) => setMessage({ tone: "neg", text: String(e) }),
    });
  }

  return (
    <div>
      <div className="row center" style={{ gap: 8, flexWrap: "wrap" }}>
        <select value={matchType} onChange={(e) => setMatchType(e.target.value as "payee" | "description")}
          aria-label="What the rule looks at" style={{ width: 168 }}>
          <option value="payee">{MATCHES.payee}</option>
          <option value="description">{MATCHES.description}</option>
        </select>
        <input value={pattern} onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          placeholder={matchType === "payee" ? "e.g. Target" : "e.g. PAYROLL"} aria-label="Text to look for"
          style={{ flex: 1, minWidth: 140 }} />
        <span className="muted">→</span>
        <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} aria-label="Category for the rule" />
        <Button onClick={save} loading={create.isPending} disabled={!ready}>Add rule</Button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Any case. The description is the bank's text, shown in grey under a transaction's name.
      </p>
      {message && <div className={`notice ${message.tone}`} style={{ marginTop: 8 }}>{message.text}</div>}
    </div>
  );
}

export function CategoriesCard() {
  const { data: categories = [] } = useCategories();
  const { data: rules = [] } = useRules();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const removeRule = useDeleteRule();
  const clear = useClearCategories();
  const setKind = useSetCategoryKind();

  const [newName, setNewName] = useState("");
  const [newColour, setNewColour] = useState("auto");
  const [editing, setEditing] = useState<Category | null>(null);
  const [error, setError] = useState("");

  const nameOf = (id: number) => categories.find((c) => c.id === id)?.name ?? "a deleted category";

  function add() {
    setError("");
    create.mutate({ name: newName, kind: "spending", colour: newColour }, {
      onSuccess: () => { setNewName(""); setNewColour("auto"); },
      onError: (e) => setError(String(e)),
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError("");
    update.mutate({ id: editing.id, name: editing.name, colour: editing.colour }, {
      onSuccess: () => setEditing(null),
      onError: (e) => setError(String(e)),
    });
  }

  return (
    <>
      <Card title="Categories" subtitle="Used to sort your spending. Add your own, or import Copilot's; rename or recolour any of them."
        actions={categories.length > 0 && (
          <Button variant="danger" size="sm" loading={clear.isPending} onClick={async () => {
            const ok = await askToConfirm(
              `Remove all ${categories.length} categories? Every transaction becomes uncategorised and goes back to To review, ` +
              "and learned rules and budgets go too. No transaction is deleted, and a backup is taken first.",
              { okLabel: "Remove all" },
            );
            if (ok) clear.mutate(undefined, { onError: (e) => setError(String(e)) });
          }}>Remove all categories</Button>
        )}>
        {categories.length === 0 && (
          <EmptyState title="No categories yet"
            body="Add one below, or import your categories from Copilot. New transactions wait in To review until they have one." />
        )}
        <div style={{ display: "grid", gap: 2 }}>
          {categories.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px" }}>
              {editing?.id === c.id ? (
                <>
                  <ColourPicker value={editing.colour} onChange={(colour) => setEditing({ ...editing, colour })} label="Colour" />
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }}
                    autoFocus style={{ flex: 1 }} aria-label="Name" />
                  <Button size="sm" onClick={saveEdit} loading={update.isPending}>Save</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <CategoryPill category={c} />
                  <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                    <select value={c.kind} aria-label={`What ${c.name} counts as`} style={{ width: 128 }}
                      title="Not counted: shows in Spending but adds to no total or budget, like a category Copilot excludes"
                      onChange={(e) => setKind.mutate({ id: c.id, kind: e.target.value as CategoryKind },
                        { onError: (err) => setError(String(err)) })}>
                      {KINDS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                    </select>
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ ...c, colour: categoryToken(c.colour) })}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={async () => {
                      if (await askToConfirm(`Delete "${c.name}"? Transactions in it become uncategorised.`)) remove.mutate(c.id);
                    }}>Delete</Button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="row center" style={{ gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <ColourPicker value={newColour} onChange={setNewColour} label="New colour" automatic />
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Add a category" style={{ flex: 1, minWidth: 160 }} aria-label="New category name" />
          <Button onClick={add} loading={create.isPending} disabled={!newName.trim()}>Add</Button>
        </div>
        {error && <div className="notice neg" style={{ marginTop: 10 }}>{error}</div>}
      </Card>

      <Card title="Rules" subtitle="A rule files every transaction it matches, past and future, unless you chose that one's category yourself.">
        <RuleForm categories={categories} />
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          {rules.length === 0 ? (
            <EmptyState title="No rules yet"
              body="Add one above, or change a transaction's category in Spending and choose “apply to all”." />
          ) : (
            // Folded away by default: an import can bring a hundred of them.
            <details>
              <summary style={{ cursor: "pointer" }}>All rules ({rules.length})</summary>
              <div style={{ display: "grid", gap: 2, paddingTop: 6 }}>
                {rules.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 4px" }}>
                    <span className="muted" style={{ fontSize: 11, width: 118, flexShrink: 0 }}>{MATCHES[r.match_type] ?? r.match_type}</span>
                    <span style={{ fontWeight: 600 }}>{r.pattern}</span>
                    <span className="muted">→ {nameOf(r.category_id)}</span>
                    <Button variant="ghost" size="sm" style={{ marginLeft: "auto" }}
                      onClick={() => removeRule.mutate(r.id)}>Delete</Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </Card>
    </>
  );
}
