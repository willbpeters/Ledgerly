import { useState } from "react";
import {
  useCategories, useRules, useCreateCategory, useUpdateCategory, useDeleteCategory, useDeleteRule,
} from "../../data/queries";
import { Card, Button, Badge, EmptyState } from "../../ui/components";
import { useChartColors } from "../../ui/chartColors";
import type { Category } from "../../domain/types";

const TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"];

export function CategoriesCard() {
  const { data: categories = [] } = useCategories();
  const { data: rules = [] } = useRules();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const removeRule = useDeleteRule();
  const colours = useChartColors();

  const [newName, setNewName] = useState("");
  const [newColour, setNewColour] = useState(TOKENS[0]);
  const [editing, setEditing] = useState<Category | null>(null);
  const [error, setError] = useState("");

  const colourOf = (token: string) => {
    const i = Number(token.replace("chart-", "")) - 1;
    return colours.series[Number.isFinite(i) && i >= 0 ? i % colours.series.length : 0];
  };
  const nameOf = (id: number) => categories.find((c) => c.id === id)?.name ?? "a deleted category";

  function add() {
    setError("");
    create.mutate({ name: newName, kind: "spending", colour: newColour }, {
      onSuccess: () => { setNewName(""); },
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
      <Card title="Categories" subtitle="Used to sort your spending. Rename or recolour any of them, including the ones Ledgerly ships with.">
        <div style={{ display: "grid", gap: 2 }}>
          {categories.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px" }}>
              {editing?.id === c.id ? (
                <>
                  <select value={editing.colour} onChange={(e) => setEditing({ ...editing, colour: e.target.value })}
                    style={{ width: 74 }} aria-label="Colour">
                    {TOKENS.map((t, i) => <option key={t} value={t}>Colour {i + 1}</option>)}
                  </select>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(null); }}
                    autoFocus style={{ flex: 1 }} aria-label="Name" />
                  <Button size="sm" onClick={saveEdit} loading={update.isPending}>Save</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: colourOf(c.colour), flexShrink: 0 }} />
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  {c.kind !== "spending" && <Badge>{c.kind}</Badge>}
                  {!c.is_builtin && <Badge tone="accent">yours</Badge>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => {
                      if (confirm(`Delete "${c.name}"? Transactions in it become uncategorised.`)) remove.mutate(c.id);
                    }}>Delete</Button>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="row center" style={{ gap: 8, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
          <select value={newColour} onChange={(e) => setNewColour(e.target.value)} style={{ width: 74 }} aria-label="New colour">
            {TOKENS.map((t, i) => <option key={t} value={t}>Colour {i + 1}</option>)}
          </select>
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
