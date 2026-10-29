import { useState } from "react";
import {
  useCategories, useRules, useCreateCategory, useUpdateCategory, useDeleteCategory, useDeleteRule,
  useClearCategories,
} from "../../data/queries";
import { Card, Button, Badge, EmptyState } from "../../ui/components";
import { CategoryPill } from "../../ui/CategoryPill";
import { CATEGORY_TOKENS, categoryColour, categoryToken } from "../../ui/categoryColour";
import { askToConfirm } from "../../ui/confirm";
import type { Category } from "../../domain/types";

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

export function CategoriesCard() {
  const { data: categories = [] } = useCategories();
  const { data: rules = [] } = useRules();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const removeRule = useDeleteRule();
  const clear = useClearCategories();

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
                  {c.kind !== "spending" && <Badge>{c.kind}</Badge>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
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

      <Card title="Learned rules" subtitle="Created when you apply a category to everything from a payee. Delete one to stop it applying.">
        {rules.length === 0 ? (
          <EmptyState title="No rules yet"
            body="Change a transaction's category in Spending and choose “apply to all”, and the rule will show up here." />
        ) : (
          <div style={{ display: "grid", gap: 2 }}>
            {rules.map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px" }}>
                <Badge>{r.match_type}</Badge>
                <span style={{ fontWeight: 600 }}>{r.pattern}</span>
                <span className="muted">→ {nameOf(r.category_id)}</span>
                <Button variant="ghost" size="sm" style={{ marginLeft: "auto" }}
                  onClick={() => removeRule.mutate(r.id)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
