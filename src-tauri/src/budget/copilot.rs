//! Importing a Copilot Money CSV export. Pure: the caller hands over the CSV
//! text and a snapshot of the database, and gets back a `Plan` it can preview
//! and then apply. See docs/superpowers/specs/2026-10-15-copilot-import-design.md
use super::seed::SystemKind;
use chrono::Datelike;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

const HEADER: [&str; 13] = [
    "date", "name", "amount", "status", "category", "parent category", "excluded",
    "tags", "type", "account", "account mask", "note", "recurring",
];

/// How far apart Copilot's date and SimpleFIN's may be for the same purchase.
const MATCH_DAYS: i64 = 3;
/// The account that collects rows whose Copilot account no longer exists.
pub const HISTORY_ACCOUNT: &str = "Copilot history";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CopilotRow {
    pub date: String,
    pub name: String,
    /// Tally's sign: negative is money out (Copilot's is the opposite).
    pub amount: f64,
    pub pending: bool,
    pub category: String,
    pub excluded: bool,
    /// "regular", "income" or "internal transfer".
    pub kind: String,
    pub account: String,
    pub mask: String,
    pub note: Option<String>,
}

pub struct AccountRef { pub id: i64, pub name: String }
pub struct ExistingTxn {
    pub id: i64, pub account_id: i64, pub posted: String, pub amount: f64, pub from_copilot: bool,
    pub external_id: String,
    /// Payee, or the description when there is none: what the preview shows.
    pub label: String,
    /// The bank's description, which matching also reads.
    pub description: String,
    pub pending: bool,
    pub removed: bool,
}
pub struct CategoryInfo {
    pub id: i64,
    pub name: String,
}
pub struct Snapshot {
    pub accounts: Vec<AccountRef>,
    pub txns: Vec<ExistingTxn>,
    pub categories: Vec<CategoryInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Target { Account(i64), History }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Match { pub txn_id: i64, pub category: Option<String>, pub note: Option<String> }
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Addition {
    pub external_id: String, pub account: Target, pub posted: String, pub amount: f64,
    pub name: String, pub category: Option<String>, pub note: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skipped { pub date: String, pub name: String, pub amount: f64, pub account: String }
/// A Tally transaction Copilot does not have — usually one the owner deleted
/// there after being paid back. Offered for removal, never removed unasked.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotInCopilot {
    pub txn_id: i64, pub date: String, pub name: String, pub amount: f64, pub account: String,
    /// Added by an earlier Copilot import, and no longer in Copilot.
    pub earlier_export: bool,
}
/// A category the export doesn't use, no budget or split piece keeps, and
/// that rows Copilot doesn't cover still hold once the import is done.
/// It goes if `kept_rows` is 0 and every one of `removable` is removed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CategoryHold {
    pub name: String,
    /// Rows holding it that the import doesn't offer to remove.
    pub kept_rows: usize,
    /// Rows holding it from `not_in_copilot`, by `txn_id`.
    pub removable: Vec<i64>,
    /// Split pieces and budgets in it. These keep it unless all categories
    /// are replaced.
    pub pinned: usize,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewCategory { pub name: String, pub kind: String }
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LearnedRule { pub pattern: String, pub category: String }

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Plan {
    pub matches: Vec<Match>,
    pub additions: Vec<Addition>,
    /// Inside a SimpleFIN span with no same-amount match: listed, not added.
    pub skipped: Vec<Skipped>,
    pub not_in_copilot: Vec<NotInCopilot>,
    pub pending_or_excluded: usize,
    pub new_categories: Vec<NewCategory>,
    pub rules: Vec<LearnedRule>,
    /// Copilot account label → the Tally account it maps to.
    pub accounts: Vec<(String, String)>,
    /// The export's newest day (pending and excluded rows aside). Nothing in
    /// Tally dated after it is changed, apart from a rename in `merges`.
    pub cutoff: String,
    /// Tally's old name → Copilot's, merged (or renamed) before anything else.
    pub merges: Vec<(String, String)>,
    /// Categories that will hold nothing after the import and that the export
    /// doesn't use, with nothing removed: deleted. Filled by
    /// `store::copilot_preview`, which dry-runs the import.
    pub deletions: Vec<String>,
    /// Every category that only rows Copilot doesn't cover keep, so the
    /// preview can say which go for whichever rows the owner ticks.
    /// Filled by `store::copilot_preview`.
    pub category_holds: Vec<CategoryHold>,
    /// Matched rows whose category changes to Copilot's. Filled by
    /// `store::copilot_preview`.
    pub recategorised: usize,
    /// Rows in Tally dated after `cutoff`, left as they are.
    pub untouched_after_cutoff: usize,
    /// Every category name the export uses, most used first: Copilot's order.
    pub export_categories: Vec<String>,
}

/// Tally's old names for categories Copilot calls something else. Merged into
/// Copilot's name when the export uses it; transfer always, since "Internal
/// transfer" is the system category.
pub const OLD_NAMES: &[(&str, &str)] = &[
    ("Dining", "Eating Out"), ("Shopping", "Shops"), ("Transfer", "Internal transfer"),
];

/// Split CSV text into records: quoted fields, doubled quotes, commas and
/// line breaks inside quotes.
fn records(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let (mut row, mut cell, mut quoted) = (Vec::new(), String::new(), false);
    let mut chars = text.trim_start_matches('\u{FEFF}').chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => { chars.next(); cell.push('"'); }
            (true, '"') => quoted = false,
            (true, c) => cell.push(c),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => { row.push(std::mem::take(&mut cell)); rows.push(std::mem::take(&mut row)); }
            (false, c) => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() { row.push(cell); rows.push(row); }
    rows
}

pub fn parse_csv(text: &str) -> Result<Vec<CopilotRow>, String> {
    let mut all = records(text).into_iter();
    let header = all.next().unwrap_or_default();
    if header.iter().map(|h| h.trim()).ne(HEADER.iter().copied()) {
        return Err("That file isn't a Copilot export. In Copilot, use Settings → Account → Export your transactions.".into());
    }
    Ok(all
        .filter(|r| r.len() == HEADER.len())
        .map(|r| CopilotRow {
            date: r[0].trim().to_string(),
            name: r[1].trim().to_string(),
            amount: -r[2].trim().parse::<f64>().unwrap_or(0.0),
            pending: r[3].trim() == "pending",
            category: r[4].trim().to_string(),
            excluded: r[6].trim() == "true",
            kind: r[8].trim().to_string(),
            account: r[9].trim().to_string(),
            mask: r[10].trim().to_string(),
            note: Some(r[11].trim().to_string()).filter(|s| !s.is_empty()),
        })
        .collect())
}

/// The category a row belongs in: Copilot's own name, exactly. An internal
/// transfer is always "Internal transfer", whatever its category says, and
/// income with no category is "Income" — the two system categories.
pub fn category_for(r: &CopilotRow) -> Option<String> {
    if r.kind == "internal transfer" {
        return Some("Internal transfer".into());
    }
    let name = r.category.trim();
    if !name.is_empty() {
        return Some(name.to_string());
    }
    (r.kind == "income").then(|| "Income".to_string())
}

/// The system category kind a `category_for` name stands for, if any.
pub fn system_kind(name: &str) -> Option<SystemKind> {
    if name.eq_ignore_ascii_case("Internal transfer") || name.eq_ignore_ascii_case("Transfer") {
        Some(SystemKind::Transfer)
    } else if name.eq_ignore_ascii_case("Income") {
        Some(SystemKind::Income)
    } else {
        None
    }
}

/// The words of a name for matching: lowercase runs of letters and digits,
/// three or more long and not all digits (store numbers, card digits).
fn words(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !w.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

fn day(s: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.num_days_from_ce() as i64)
}

/// FNV-1a: a stable id without a hashing dependency.
fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

pub fn plan(rows: &[CopilotRow], snap: &Snapshot) -> Plan {
    let mut p = Plan::default();
    let cents = |a: f64| (a * 100.0).round() as i64;
    // The newest day of the whole file. Nothing in Tally after it is touched.
    let newest = rows.iter().filter(|r| !r.pending && !r.excluded).map(|r| r.date.as_str()).max().unwrap_or("");
    p.cutoff = newest.to_string();

    // Where SimpleFIN's own record of each account starts. Copilot rows from
    // that date on are matched, never added; imported rows do not count.
    let mut span: BTreeMap<i64, String> = BTreeMap::new();
    for t in snap.txns.iter().filter(|t| !t.from_copilot && t.posted.as_str() >= "2000") {
        let e = span.entry(t.account_id).or_insert_with(|| t.posted.clone());
        if t.posted < *e { *e = t.posted.clone(); }
    }

    let account_for = |r: &CopilotRow| -> Target {
        if r.mask.is_empty() { return Target::History; }
        snap.accounts.iter().find(|a| a.name.ends_with(&format!("({})", r.mask)))
            .map_or(Target::History, |a| Target::Account(a.id))
    };

    let mut used: HashSet<i64> = HashSet::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut labels: BTreeMap<String, String> = BTreeMap::new();
    // The dates Copilot covers for each Tally account, first to last.
    let mut covers: BTreeMap<i64, (String, String)> = BTreeMap::new();

    for r in rows {
        if r.pending || r.excluded { p.pending_or_excluded += 1; continue; }
        let category = category_for(r);
        let target = account_for(r);
        if let Target::Account(id) = target {
            let c = covers.entry(id).or_insert_with(|| (r.date.clone(), r.date.clone()));
            if r.date < c.0 { c.0 = r.date.clone(); }
            if r.date > c.1 { c.1 = r.date.clone(); }
        }
        let label = if r.account.is_empty() { "(no account)".to_string() } else { r.account.clone() };
        labels.entry(label.clone()).or_insert_with(|| match &target {
            Target::Account(id) => snap.accounts.iter().find(|a| a.id == *id).map_or(String::new(), |a| a.name.clone()),
            Target::History => HISTORY_ACCOUNT.to_string(),
        });

        if let Target::Account(id) = target {
            if span.get(&id).is_some_and(|start| r.date >= *start) {
                let Some(d) = day(&r.date) else { continue };
                // Account, amount and a few days aren't enough on their own: a
                // $10 Polymarket row once matched a $10 Chick-fil-a. Another
                // day also needs a word in common with the payee or description.
                let name_words = words(&r.name);
                let best = snap.txns.iter()
                    .filter(|t| t.account_id == id && !t.from_copilot && !used.contains(&t.id) && cents(t.amount) == cents(r.amount))
                    .filter_map(|t| day(&t.posted).map(|td| ((td - d).abs(), t)))
                    .filter(|(gap, t)| *gap == 0 || (*gap <= MATCH_DAYS && {
                        let theirs = words(&format!("{} {}", t.label, t.description));
                        !name_words.is_disjoint(&theirs)
                    }))
                    .map(|(gap, t)| (gap, t.id))
                    .min();
                match best {
                    Some((_, txn_id)) => {
                        used.insert(txn_id);
                        // Tally may date it a day or two after Copilot; past
                        // the cutoff it is matched (so not offered for
                        // removal) but left as it is.
                        let posted = snap.txns.iter().find(|t| t.id == txn_id).map_or("", |t| t.posted.as_str());
                        if posted <= newest {
                            p.matches.push(Match { txn_id, category, note: r.note.clone() });
                        }
                    }
                    None => p.skipped.push(Skipped { date: r.date.clone(), name: r.name.clone(), amount: r.amount, account: label }),
                }
                continue;
            }
        }

        // Its position among identical rows keeps two same-day vending
        // purchases apart, and gives the same id on every import.
        let key = format!("{}|{}|{}|{}", r.date, r.name, cents(r.amount), r.mask);
        let n = seen.entry(key.clone()).or_insert(0);
        *n += 1;
        p.additions.push(Addition {
            external_id: format!("copilot:{:016x}", fnv(&format!("{key}|{n}"))),
            account: target, posted: r.date.clone(), amount: r.amount,
            name: r.name.clone(), category, note: r.note.clone(),
        });
    }

    // Tally rows Copilot does not have, from the first date Copilot covers
    // for that account. Only the export's own newest day is left alone: Copilot
    // runs a few hours behind the bank, so a row from that day may simply not
    // have reached it yet. The newest day of the whole file, not the account's —
    // an account with nothing on that day would otherwise push its cutoff back.
    //
    // A row an earlier Copilot import added that this export no longer has
    // was deleted in Copilot since: offered too, up to and including the
    // newest day (no lag here, an earlier export already had it), in a covered
    // account or in Copilot history from the export's first day on.
    let earliest = rows.iter().filter(|r| !r.pending && !r.excluded).map(|r| r.date.as_str()).min().unwrap_or("");
    let history = snap.accounts.iter().find(|a| a.name == HISTORY_ACCOUNT).map(|a| a.id);
    let still: HashSet<&str> = p.additions.iter().map(|a| a.external_id.as_str()).collect();
    for t in &snap.txns {
        if t.pending || t.removed || used.contains(&t.id) { continue; }
        let first = match covers.get(&t.account_id) {
            Some((first, _)) => first.as_str(),
            None if t.from_copilot && history == Some(t.account_id) => earliest,
            None => continue,
        };
        let offered = if t.from_copilot {
            !still.contains(t.external_id.as_str()) && t.posted.as_str() >= first && t.posted.as_str() <= newest
        } else {
            t.posted.as_str() >= first && t.posted.as_str() < newest
        };
        if !offered { continue; }
        p.not_in_copilot.push(NotInCopilot {
            txn_id: t.id, date: t.posted.clone(), name: t.label.clone(), amount: t.amount,
            account: snap.accounts.iter().find(|a| a.id == t.account_id).map_or(String::new(), |a| a.name.clone()),
            earlier_export: t.from_copilot,
        });
    }
    p.not_in_copilot.sort_by(|a, b| b.date.cmp(&a.date));

    // Every category the export uses, most used first, in Copilot's spelling.
    let mut uses: BTreeMap<String, (String, usize)> = BTreeMap::new();
    for c in rows.iter().filter(|r| !r.pending && !r.excluded).filter_map(category_for) {
        uses.entry(c.to_lowercase()).or_insert_with(|| (c.clone(), 0)).1 += 1;
    }
    // A transfer's own category (one Copilot has, like Car) is still one of
    // Copilot's categories, though the row itself is an internal transfer.
    for r in rows.iter().filter(|r| !r.pending && !r.excluded && r.kind == "internal transfer") {
        let c = r.category.trim();
        if !c.is_empty() {
            uses.entry(c.to_lowercase()).or_insert_with(|| (c.to_string(), 0)).1 += 1;
        }
    }
    let mut order: Vec<(String, usize)> = uses.values().cloned().collect();
    order.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    p.export_categories = order.into_iter().map(|(name, _)| name).collect();
    let in_export = |name: &str| uses.contains_key(&name.to_lowercase());

    // Copilot's spelling, then Tally's old names give way to Copilot's.
    // `names` is each category's name once that is done.
    let mut names: BTreeMap<i64, String> = snap.categories.iter().map(|c| (c.id, c.name.clone())).collect();
    for c in &snap.categories {
        let Some((spelling, _)) = uses.get(&c.name.to_lowercase()) else { continue };
        // Two spellings in Tally: the other folds into the exact one.
        if *spelling != c.name {
            names.insert(c.id, spelling.clone());
            p.merges.push((c.name.clone(), spelling.clone()));
        }
    }
    for (old, new) in OLD_NAMES {
        let Some(from) = snap.categories.iter().find(|c| c.name.eq_ignore_ascii_case(old)) else { continue };
        // Copilot uses the old name itself: it is the owner's, keep it.
        if in_export(old) || !(in_export(new) || system_kind(new) == Some(SystemKind::Transfer)) {
            continue;
        }
        let to = names.iter().any(|(id, n)| *id != from.id && n.eq_ignore_ascii_case(new));
        if to { names.remove(&from.id); } else { names.insert(from.id, new.to_string()); }
        p.merges.push((from.name.clone(), new.to_string()));
    }

    // Categories the owner used that Tally does not have yet. Transfer and
    // Income are Tally's system categories, made when first needed with the
    // right kind, so they are never offered as new spending.
    let have: HashSet<String> = names.values().map(|c| c.to_lowercase()).collect();
    let mut wanted: Vec<String> = uses.values().map(|(name, _)| name.clone()).collect();
    wanted.sort();
    p.new_categories = wanted.into_iter()
        .filter(|c| !have.contains(&c.to_lowercase()) && system_kind(c).is_none())
        .map(|name| NewCategory {
            // Money moved into the owner's own investments is not spending.
            kind: if name.eq_ignore_ascii_case("investments") { "transfer" } else { "spending" }.into(),
            name,
        })
        .collect();

    p.untouched_after_cutoff = snap.txns.iter().filter(|t| t.posted.as_str() > newest).count();

    // A payee used at least twice, 90% of the time in one category. It
    // replaces any rule the payee already has: Copilot's choice wins.
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in rows.iter().filter(|r| !r.pending && !r.excluded) {
        if let Some(c) = category_for(r) {
            by_name.entry(r.name.trim().to_lowercase()).or_default().push(c);
        }
    }
    for (name, used_cats) in by_name {
        // Payments to people stay the owner's call each time, as in the ladder.
        if name.is_empty() || used_cats.len() < 2 || super::merchants::is_person_to_person(Some(&name), "") {
            continue;
        }
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for c in &used_cats { *counts.entry(c.as_str()).or_default() += 1; }
        let (top, n) = counts.into_iter().max_by_key(|(_, n)| *n).expect("at least two categories");
        if n * 10 >= used_cats.len() * 9 {
            p.rules.push(LearnedRule { pattern: name, category: top.to_string() });
        }
    }

    p.accounts = labels.into_iter().collect();
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "\"date\",\"name\",\"amount\",\"status\",\"category\",\"parent category\",\"excluded\",\"tags\",\"type\",\"account\",\"account mask\",\"note\",\"recurring\"";

    fn csv(rows: &[&str]) -> String {
        format!("\u{FEFF}{HEADER}\n{}\n", rows.join("\n"))
    }

    fn row(date: &str, name: &str, amount: &str, category: &str, kind: &str, mask: &str) -> String {
        format!("\"{date}\",\"{name}\",\"{amount}\",\"posted\",\"{category}\",\"\",\"false\",\"\",\"{kind}\",\"Acct\",\"{mask}\",\"\",\"\"")
    }

    fn existing(id: i64, posted: &str, amount: f64) -> ExistingTxn {
        ExistingTxn {
            id, account_id: 1, posted: posted.into(), amount, from_copilot: false,
            external_id: format!("sf{id}"), label: format!("Payee {id}"), description: format!("PAYEE {id}"),
            pending: false, removed: false,
        }
    }

    /// A row an earlier Copilot import added.
    fn imported(id: i64, account_id: i64, posted: &str, amount: f64) -> ExistingTxn {
        ExistingTxn { account_id, from_copilot: true, external_id: format!("copilot:old{id}"), ..existing(id, posted, amount) }
    }

    /// Copilot covers account 1 from 07-01 to 07-20; Tally holds 10 and 11
    /// (matched by the two rows below) plus whatever a test adds.
    fn covered(extra: Vec<ExistingTxn>) -> (Vec<CopilotRow>, Snapshot) {
        let rows = parse_csv(&csv(&[
            &row("2026-07-01", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-05", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-20", "Later", "3.00", "Other", "regular", "9849"),
        ])).unwrap();
        let mut s = snap();
        s.txns.extend(extra);
        (rows, s)
    }

    #[test]
    fn a_ledgerly_row_copilot_does_not_have_is_offered_for_removal() {
        // The owner deletes a transaction in Copilot when they are paid back.
        let (rows, s) = covered(vec![existing(20, "2026-07-10", 45.0)]);
        let p = plan(&rows, &s);
        let ids: Vec<i64> = p.not_in_copilot.iter().map(|n| n.txn_id).collect();
        assert_eq!(ids, vec![20]);
        assert_eq!(p.not_in_copilot[0].name, "Payee 20");
    }

    #[test]
    fn only_the_exports_last_day_is_too_new_to_offer() {
        // Copilot runs a few hours behind the bank: on the export's newest day
        // it may not have everything yet, but the day before it has.
        let (rows, s) = covered(vec![existing(21, "2026-07-19", 45.0), existing(22, "2026-07-20", 46.0)]);
        let ids: Vec<i64> = plan(&rows, &s).not_in_copilot.iter().map(|n| n.txn_id).collect();
        assert_eq!(ids, vec![21]);
    }

    #[test]
    fn the_cutoff_is_the_whole_exports_newest_day_not_the_accounts() {
        // The owner's export ended 10-15, but their Bank of America account's
        // last Copilot row was 10-14; a 10-13 row there must still be offered.
        let mut rows = covered(vec![]).0;
        rows.push(parse_csv(&csv(&[&row("2026-07-30", "Elsewhere", "1.00", "Other", "regular", "")])).unwrap().remove(0));
        let mut s = snap();
        s.txns.push(existing(23, "2026-07-25", 45.0));
        let ids: Vec<i64> = plan(&rows, &s).not_in_copilot.iter().map(|n| n.txn_id).collect();
        assert_eq!(ids, vec![23]);
    }

    #[test]
    fn pending_removed_and_imported_rows_are_not_offered() {
        let mut pending = existing(22, "2026-07-10", 1.0);
        pending.pending = true;
        let mut removed = existing(23, "2026-07-10", 2.0);
        removed.removed = true;
        let mut gone = imported(24, 1, "2026-07-10", 3.0);
        gone.removed = true;
        let (rows, s) = covered(vec![pending, removed, gone]);
        assert!(plan(&rows, &s).not_in_copilot.is_empty());
    }

    #[test]
    fn a_row_from_an_earlier_export_that_copilot_no_longer_has_is_offered() {
        // In a covered account, and in Copilot history, up to and including
        // the cutoff (an earlier export had it, so Copilot isn't lagging).
        let (mut rows, mut s) = covered(vec![]);
        s.accounts.push(AccountRef { id: 5, name: HISTORY_ACCOUNT.into() });
        rows.push(parse_csv(&csv(&[&row("2026-06-01", "Old", "2.00", "Other", "regular", "")])).unwrap().remove(0));
        let still = plan(&rows, &s).additions[0].external_id.clone();
        s.txns.extend([
            imported(60, 1, "2026-07-20", 4.0),
            imported(61, 5, "2026-06-15", 5.0),
            // Before the export starts, or one this export still has: kept.
            imported(62, 5, "2026-05-01", 6.0),
            ExistingTxn { external_id: still, ..imported(63, 5, "2026-06-01", -2.0) },
            // An account the export doesn't cover.
            imported(64, 9, "2026-07-10", 7.0),
        ]);
        let p = plan(&rows, &s);
        let offered: Vec<(i64, bool)> = p.not_in_copilot.iter().map(|n| (n.txn_id, n.earlier_export)).collect();
        assert_eq!(offered, vec![(60, true), (61, true)]);
    }

    #[test]
    fn a_tally_row_is_not_marked_as_from_an_earlier_export() {
        let (rows, s) = covered(vec![existing(20, "2026-07-10", 45.0)]);
        assert!(!plan(&rows, &s).not_in_copilot[0].earlier_export);
    }

    #[test]
    fn a_match_needs_the_same_day_or_a_shared_word() {
        // The dry run matched a $10 Polymarket row to Copilot's $10
        // Chick-fil-a a day earlier.
        let rows = parse_csv(&csv(&[
            &row("2026-07-02", "Chick-fil-a", "10.00", "Eating Out", "regular", "9849"),
            &row("2026-07-20", "Later", "3.00", "Other", "regular", "9849"),
        ])).unwrap();
        let mut s = snap();
        s.txns.push(ExistingTxn { label: "Polymarket".into(), description: "POLYMARKET 12345".into(), ..existing(70, "2026-07-03", -10.0) });
        let p = plan(&rows, &s);
        assert!(!p.matches.iter().any(|m| m.txn_id == 70));
        assert_eq!(p.skipped.len(), 2);
    }

    #[test]
    fn a_shared_word_matches_across_days_and_the_same_day_needs_none() {
        let rows = parse_csv(&csv(&[
            &row("2026-07-02", "Chick-fil-a", "10.00", "Eating Out", "regular", "9849"),
            &row("2026-07-07", "Some Name", "8.00", "Other", "regular", "9849"),
            &row("2026-07-20", "Later", "3.00", "Other", "regular", "9849"),
        ])).unwrap();
        let mut s = snap();
        s.txns.extend([
            ExistingTxn { label: "Chick-fil-A".into(), description: "CHICK-FIL-A #0123".into(), ..existing(71, "2026-07-04", -10.0) },
            ExistingTxn { label: "Unrelated".into(), description: "POS 4411".into(), ..existing(72, "2026-07-07", -8.0) },
        ]);
        let ids: Vec<i64> = plan(&rows, &s).matches.iter().map(|m| m.txn_id).collect();
        assert_eq!(ids, vec![71, 72]);
    }

    #[test]
    fn words_are_lowercase_letters_and_digits_of_three_or_more_not_all_digits() {
        assert_eq!(words("Chick-fil-A #0123 at SQ*Joe"), ["chick", "fil", "joe"].map(String::from).into_iter().collect());
    }

    #[test]
    fn a_category_spelt_differently_takes_copilots_spelling() {
        let rows = parse_csv(&csv(&[&row("2026-01-02", "Diner", "5", "Eating Out", "regular", "")])).unwrap();
        let mut s = snap();
        s.categories.push(cat(7, "Eating out"));
        let p = plan(&rows, &s);
        // Spelling first, so Dining then merges into "Eating Out".
        assert_eq!(p.merges, vec![
            ("Eating out".to_string(), "Eating Out".to_string()),
            ("Dining".to_string(), "Eating Out".to_string()),
            ("Transfer".to_string(), "Internal transfer".to_string()),
        ]);
        assert!(p.new_categories.is_empty());
    }

    #[test]
    fn an_account_copilot_does_not_cover_is_not_looked_at() {
        let mut other = existing(25, "2026-07-10", 9.0);
        other.account_id = 2;
        let (rows, mut s) = covered(vec![other]);
        s.accounts.push(AccountRef { id: 2, name: "Brokerage (1111)".into() });
        assert!(plan(&rows, &s).not_in_copilot.is_empty());
    }

    fn snap() -> Snapshot {
        Snapshot {
            accounts: vec![AccountRef { id: 1, name: "Card (9849)".into() }],
            txns: vec![
                existing(10, "2026-07-01", -12.5),
                existing(11, "2026-07-05", -12.5),
            ],
            categories: ["Dining", "Shopping", "Groceries", "Transfer", "Income", "Other"].iter().enumerate()
                .map(|(i, n)| cat(i as i64 + 1, n)).collect(),
        }
    }

    fn cat(id: i64, name: &str) -> CategoryInfo {
        CategoryInfo { id, name: name.into() }
    }

    #[test]
    fn a_file_that_is_not_a_copilot_export_is_refused() {
        assert!(parse_csv("date,description,amount\n2026-01-01,x,1\n").unwrap_err().contains("Copilot"));
    }

    #[test]
    fn quoted_fields_and_doubled_quotes_parse() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Joe \"\"The\"\" Diner, Inc", "12.50", "Eating Out", "regular", "9849")])).unwrap();
        assert_eq!(rows[0].name, "Joe \"The\" Diner, Inc");
    }

    #[test]
    fn copilots_sign_is_flipped() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Cafe", "12.50", "", "regular", ""),
                                    &row("2026-07-02", "Pay", "-100", "", "income", "")])).unwrap();
        assert_eq!((rows[0].amount, rows[1].amount), (-12.5, 100.0));
    }

    #[test]
    fn categories_keep_copilots_own_names() {
        let r = |cat: &str, kind: &str| CopilotRow { category: cat.into(), kind: kind.into(), ..CopilotRow::default() };
        assert_eq!(category_for(&r("Eating Out", "regular")).as_deref(), Some("Eating Out"));
        assert_eq!(category_for(&r("Shops", "regular")).as_deref(), Some("Shops"));
        assert_eq!(category_for(&r("Gifts ", "regular")).as_deref(), Some("Gifts"));
        assert_eq!(category_for(&r("Golf", "internal transfer")).as_deref(), Some("Internal transfer"));
        assert_eq!(category_for(&r("", "income")).as_deref(), Some("Income"));
        assert_eq!(category_for(&r("", "regular")), None);
    }

    #[test]
    fn a_row_inside_the_span_matches_closest_date_first_and_only_once() {
        let rows = parse_csv(&csv(&[
            &row("2026-07-04", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-02", "Diner", "12.50", "Eating Out", "regular", "9849"),
            // Moves the cutoff past both Tally rows.
            &row("2026-07-10", "Later", "1.00", "Other", "regular", "9849"),
        ])).unwrap();
        let mut s = snap();
        for t in &mut s.txns { t.label = "Joe's Diner".into(); }
        let p = plan(&rows, &s);
        let ids: Vec<i64> = p.matches.iter().map(|m| m.txn_id).collect();
        assert_eq!(ids, vec![11, 10]);
        assert_eq!(p.matches[0].category.as_deref(), Some("Eating Out"));
        assert!(p.additions.is_empty());
    }

    #[test]
    fn an_unmatched_row_inside_the_span_is_skipped_not_added() {
        let rows = parse_csv(&csv(&[&row("2026-07-10", "Mystery", "9.99", "Other", "regular", "9849")])).unwrap();
        let p = plan(&rows, &snap());
        assert!(p.additions.is_empty());
        assert_eq!(p.skipped.len(), 1);
    }

    #[test]
    fn a_row_before_the_span_is_added_to_its_account() {
        let rows = parse_csv(&csv(&[&row("2026-01-10", "Old Diner", "8.00", "Eating Out", "regular", "9849")])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.additions.len(), 1);
        assert_eq!(p.additions[0].account, Target::Account(1));
        assert_eq!(p.additions[0].amount, -8.0);
        assert!(p.additions[0].external_id.starts_with("copilot:"));
    }

    #[test]
    fn a_row_with_no_known_account_goes_to_copilot_history() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Cash", "5.00", "Other", "regular", "")])).unwrap();
        assert_eq!(plan(&rows, &snap()).additions[0].account, Target::History);
    }

    #[test]
    fn pending_and_excluded_rows_are_skipped() {
        let pending = row("2026-01-02", "P", "1", "", "regular", "").replace("\"posted\"", "\"pending\"");
        let excluded = row("2026-01-02", "E", "1", "", "regular", "").replace("\"false\"", "\"true\"");
        let p = plan(&parse_csv(&csv(&[&pending, &excluded])).unwrap(), &snap());
        assert_eq!((p.additions.len(), p.pending_or_excluded), (0, 2));
    }

    #[test]
    fn identical_rows_get_different_stable_ids() {
        let a = row("2026-01-02", "Vending", "1.50", "", "regular", "");
        let rows = parse_csv(&csv(&[&a, &a])).unwrap();
        let first = plan(&rows, &snap());
        let again = plan(&rows, &snap());
        assert_ne!(first.additions[0].external_id, first.additions[1].external_id);
        assert_eq!(first.additions[0].external_id, again.additions[0].external_id);
    }

    #[test]
    fn missing_categories_are_listed_with_investments_as_a_transfer() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Range", "20", "Golf", "regular", ""),
            &row("2026-01-03", "Robinhood", "100", "Investments", "regular", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.new_categories, vec![
            NewCategory { name: "Golf".into(), kind: "spending".into() },
            NewCategory { name: "Investments".into(), kind: "transfer".into() },
        ]);
    }

    #[test]
    fn a_payee_used_consistently_becomes_a_rule() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Haggin Oaks", "20", "Golf", "regular", ""),
            &row("2026-01-09", "Haggin Oaks", "25", "Golf", "regular", ""),
            &row("2026-01-03", "Once Only", "5", "Golf", "regular", ""),
            &row("2026-01-04", "Mixed", "5", "Golf", "regular", ""),
            &row("2026-01-05", "Mixed", "5", "Other", "regular", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.rules, vec![LearnedRule { pattern: "haggin oaks".into(), category: "Golf".into() }]);
    }

    #[test]
    fn no_rule_is_learned_for_payments_to_people() {
        // The owner decides each Apple Pay, Venmo or Zelle payment; a rule
        // learned from Copilot would quietly decide them instead.
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Transfer to Apple Pay", "20", "Other", "regular", ""),
            &row("2026-01-09", "Transfer to Apple Pay", "25", "Other", "regular", ""),
        ])).unwrap();
        assert!(plan(&rows, &snap()).rules.is_empty());
    }

    #[test]
    fn a_payee_with_a_rule_still_learns_copilots_category() {
        // Copilot wins: applying the plan replaces the payee's rule.
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Haggin Oaks", "20", "Golf", "regular", ""),
            &row("2026-01-09", "Haggin Oaks", "25", "Golf", "regular", ""),
        ])).unwrap();
        assert_eq!(plan(&rows, &snap()).rules.len(), 1);
    }

    #[test]
    fn the_cutoff_is_the_exports_newest_posted_day() {
        let mut rows = covered(vec![]).0;
        let pending = row("2026-07-25", "P", "1", "", "regular", "").replace("\"posted\"", "\"pending\"");
        rows.push(parse_csv(&csv(&[&pending])).unwrap().remove(0));
        let mut s = snap();
        s.txns.extend([existing(30, "2026-07-21", 1.0), existing(31, "2026-07-22", 2.0), existing(32, "2026-07-20", 3.0)]);
        let p = plan(&rows, &s);
        assert_eq!(p.cutoff, "2026-07-20");
        assert_eq!(p.untouched_after_cutoff, 2);
    }

    #[test]
    fn a_match_tally_dates_after_the_cutoff_is_left_alone_and_not_offered() {
        // Copilot's last row is 07-20; Tally has the same purchase on 07-21.
        let rows = parse_csv(&csv(&[
            &row("2026-07-01", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-05", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-20", "Late", "3.00", "Other", "regular", "9849"),
        ])).unwrap();
        let mut s = snap();
        s.txns.push(ExistingTxn { label: "Late Night".into(), ..existing(40, "2026-07-21", -3.0) });
        let p = plan(&rows, &s);
        assert_eq!(p.matches.iter().map(|m| m.txn_id).collect::<Vec<_>>(), vec![10, 11]);
        assert!(p.not_in_copilot.is_empty());
        assert_eq!(p.untouched_after_cutoff, 1);
    }

    #[test]
    fn old_names_merge_into_copilots_when_the_export_uses_them() {
        let rows = parse_csv(&csv(&[&row("2026-01-02", "Diner", "5", "Eating Out", "regular", "")])).unwrap();
        let p = plan(&rows, &snap());
        // Shops is not in the export, so Shopping stays; Transfer always merges
        // (the preview drops it again if Internal transfer would be deleted).
        assert_eq!(p.merges, vec![
            ("Dining".to_string(), "Eating Out".to_string()),
            ("Transfer".to_string(), "Internal transfer".to_string()),
        ]);
        assert!(p.new_categories.is_empty(), "Dining is renamed, not joined by a new Eating Out");
    }

    #[test]
    fn an_old_name_copilot_uses_itself_is_not_merged() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Diner", "5", "Eating Out", "regular", ""),
            &row("2026-01-03", "Bistro", "5", "Dining", "regular", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert!(!p.merges.iter().any(|(from, _)| from == "Dining"));
    }

    #[test]
    fn export_categories_are_in_copilots_order_most_used_first() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "A", "5", "Golf", "regular", ""),
            &row("2026-01-03", "B", "5", "Shops", "regular", ""),
            &row("2026-01-04", "C", "5", "shops", "regular", ""),
            &row("2026-01-05", "D", "5", "", "internal transfer", ""),
        ])).unwrap();
        assert_eq!(plan(&rows, &snap()).export_categories, vec!["Shops", "Golf", "Internal transfer"]);
    }

    #[test]
    fn a_category_only_a_transfer_carries_is_still_copilots() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "A", "5", "Golf", "regular", ""),
            &row("2026-01-05", "Smog", "5", "Car", "internal transfer", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert!(p.export_categories.contains(&"Car".to_string()));
        assert!(p.new_categories.iter().any(|c| c.name == "Car"), "made, so it isn't lost");
    }
}
