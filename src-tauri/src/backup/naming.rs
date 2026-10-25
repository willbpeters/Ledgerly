//! Backup file names. The name alone carries the date, the time and the kind,
//! so "is there a backup today?" and "which files does pruning remove?" are
//! answered from a list of names, without touching disk.
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;

/// How many `daily` backups are kept: about two weeks. Every other kind is
/// kept until the owner deletes it, because each marks a moment worth
/// returning to (an update, a restore, a deliberate click).
pub const KEEP_DAILY: usize = 14;

const PREFIX: &str = "ledgerly-";
const EXT: &str = ".sqlite";
/// `2026-10-14-093012-` — the fixed-width part of every name.
const STAMP_LEN: usize = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Daily,
    PreMigration,
    PreRestore,
    Manual,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::Daily, Kind::PreMigration, Kind::PreRestore, Kind::Manual];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Daily => "daily",
            Kind::PreMigration => "pre-migration",
            Kind::PreRestore => "pre-restore",
            Kind::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub date: NaiveDate,
    pub time: NaiveTime,
    pub kind: Kind,
}

/// `ledgerly-2026-10-14-093012-daily.sqlite`. An `n` above 1 appends `-n`,
/// for two backups in the same second: `VACUUM INTO` refuses to overwrite.
pub fn file_name(at: NaiveDateTime, kind: Kind, n: u32) -> String {
    let stem = format!("{PREFIX}{}-{}", at.format("%Y-%m-%d-%H%M%S"), kind.as_str());
    if n > 1 {
        format!("{stem}-{n}{EXT}")
    } else {
        format!("{stem}{EXT}")
    }
}

/// The inverse of `file_name`. Anything else in the folder parses to `None`,
/// which is what keeps pruning away from files Tally did not write.
pub fn parse(name: &str) -> Option<Parsed> {
    let body = name.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    if !body.is_ascii() || body.len() <= STAMP_LEN {
        return None;
    }
    let (stamp, rest) = body.split_at(STAMP_LEN);
    if &stamp[10..11] != "-" || &stamp[17..18] != "-" {
        return None;
    }
    let date = NaiveDate::parse_from_str(&stamp[..10], "%Y-%m-%d").ok()?;
    let time = NaiveTime::parse_from_str(&stamp[11..17], "%H%M%S").ok()?;
    let kind = Kind::ALL.into_iter().find(|k| {
        rest == k.as_str()
            || rest
                .strip_prefix(k.as_str())
                .and_then(|r| r.strip_prefix('-'))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    })?;
    Some(Parsed { date, time, kind })
}

/// Has a backup of any kind already been made on `day`? Any kind counts: a
/// manual backup this morning makes a daily one this afternoon redundant.
pub fn has_backup_on(names: &[String], day: NaiveDate) -> bool {
    names.iter().filter_map(|n| parse(n)).any(|p| p.date == day)
}

/// The `daily` backups beyond the newest `keep`, oldest last. Only `daily`
/// files are ever returned.
pub fn to_prune(names: &[String], keep: usize) -> Vec<String> {
    let mut daily: Vec<(Parsed, &String)> = names
        .iter()
        .filter_map(|n| parse(n).map(|p| (p, n)))
        .filter(|(p, _)| p.kind == Kind::Daily)
        .collect();
    daily.sort_by(|a, b| (b.0.date, b.0.time, b.1).cmp(&(a.0.date, a.0.time, a.1)));
    daily.into_iter().skip(keep).map(|(_, n)| n.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn daily_on(d: u32) -> String {
        file_name(at(&format!("2026-10-{d:02} 09:00:00")), Kind::Daily, 1)
    }

    #[test]
    fn a_name_carries_date_time_and_kind() {
        assert_eq!(
            file_name(at("2026-10-14 09:30:12"), Kind::Daily, 1),
            "ledgerly-2026-10-14-093012-daily.sqlite"
        );
        assert_eq!(
            file_name(at("2026-10-14 09:30:12"), Kind::PreMigration, 2),
            "ledgerly-2026-10-14-093012-pre-migration-2.sqlite"
        );
    }

    #[test]
    fn every_kind_round_trips_through_its_name() {
        for kind in Kind::ALL {
            for n in [1, 2, 10] {
                let parsed = parse(&file_name(at("2026-10-14 09:30:12"), kind, n)).unwrap();
                assert_eq!(
                    parsed,
                    Parsed {
                        date: day("2026-10-14"),
                        time: NaiveTime::from_hms_opt(9, 30, 12).unwrap(),
                        kind
                    }
                );
            }
        }
    }

    #[test]
    fn files_that_are_not_backups_are_ignored() {
        for name in [
            "finance.sqlite",
            "notes.txt",
            "ledgerly-2026-10-14-093012-weekly.sqlite",
            "ledgerly-2026-13-14-093012-daily.sqlite",
            "ledgerly-2026-10-14-093012-daily-.sqlite",
            "ledgerly-2026-10-14-093012-daily-x.sqlite",
            "ledgerly-2026-10-14-093012-daily.sqlite.tmp",
            "ledgerly-2026-10-14-0930-daily.sqlite",
            "ledgerly-é026-10-14-093012-daily.sqlite",
        ] {
            assert_eq!(parse(name), None, "{name} must not parse");
        }
    }

    #[test]
    fn a_backup_of_any_kind_today_counts_and_yesterday_does_not() {
        let yesterday = file_name(at("2026-10-13 23:59:59"), Kind::Daily, 1);
        let manual_today = file_name(at("2026-10-14 08:00:00"), Kind::Manual, 1);
        let names = vec![yesterday.clone(), manual_today, "finance.sqlite".to_string()];
        assert!(has_backup_on(&names, day("2026-10-14")));
        assert!(!has_backup_on(&[yesterday], day("2026-10-14")));
    }

    #[test]
    fn pruning_removes_only_the_oldest_dailies_beyond_the_limit() {
        let mut names: Vec<String> = (1..=16).map(daily_on).collect();
        for kind in [Kind::Manual, Kind::PreMigration, Kind::PreRestore] {
            names.push(file_name(at("2026-09-01 09:00:00"), kind, 1));
        }
        names.push("finance.sqlite".to_string());

        assert_eq!(to_prune(&names, KEEP_DAILY), vec![daily_on(2), daily_on(1)]);
    }

    #[test]
    fn nothing_is_pruned_at_the_limit() {
        let names: Vec<String> = (1..=14).map(daily_on).collect();
        assert!(to_prune(&names, KEEP_DAILY).is_empty());
    }
}
