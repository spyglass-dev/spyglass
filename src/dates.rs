//! Relative-date resolution — the grammar behind `"date_range": "last 30 days"`.
//!
//! Resolution is **pure**: it takes the clock as an argument and never reads
//! system time, so a saved document stores the *intent* and the window moves,
//! while tests pin the clock. Periods are calendar-aligned in the query's
//! timezone (IANA name, default UTC) and emitted as UTC RFC3339 instants for
//! `timestamptz` comparison — always as a half-open `[from, to)` window.
//!
//! Grammar (case-insensitive; underscores allowed for spaces):
//! - `today` · `yesterday`
//! - `last N days|weeks|months|quarters|years` — the current period plus the
//!   N−1 before it (so `last 30 days` includes today)
//! - `this week|month|quarter|year` — the current calendar period
//! - `previous week|month|quarter|year` (alias: `last <unit>` with no number)
//! - `ytd` — start of the year through the end of today
//!
//! Weeks start on Monday (ISO).

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

/// A calendar unit the grammar understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

fn parse_unit(s: &str) -> Option<Unit> {
    match s.trim_end_matches('s') {
        "day" => Some(Unit::Day),
        "week" => Some(Unit::Week),
        "month" => Some(Unit::Month),
        "quarter" => Some(Unit::Quarter),
        "year" => Some(Unit::Year),
        _ => None,
    }
}

/// Start of the calendar period containing `date`.
fn period_start(date: NaiveDate, unit: Unit) -> NaiveDate {
    match unit {
        Unit::Day => date,
        Unit::Week => date - Duration::days(date.weekday().num_days_from_monday() as i64),
        Unit::Month => date.with_day(1).expect("day 1 exists"),
        Unit::Quarter => {
            let month = ((date.month0() / 3) * 3) + 1;
            NaiveDate::from_ymd_opt(date.year(), month, 1).expect("quarter start exists")
        }
        Unit::Year => NaiveDate::from_ymd_opt(date.year(), 1, 1).expect("year start exists"),
    }
}

/// The same day `n` periods earlier/later, staying on period starts.
fn shift_period_start(start: NaiveDate, unit: Unit, n: i32) -> NaiveDate {
    match unit {
        Unit::Day => start + Duration::days(n as i64),
        Unit::Week => start + Duration::weeks(n as i64),
        Unit::Month | Unit::Quarter => {
            let step = if unit == Unit::Quarter { 3 * n } else { n };
            let months = start.year() * 12 + start.month0() as i32 + step;
            let (year, month0) = (months.div_euclid(12), months.rem_euclid(12));
            NaiveDate::from_ymd_opt(year, month0 as u32 + 1, 1).expect("month start exists")
        }
        Unit::Year => NaiveDate::from_ymd_opt(start.year() + n, 1, 1).expect("year start exists"),
    }
}

/// Resolve a relative-range expression to `[from, to)` UTC RFC3339 instants,
/// evaluated at `now` in `tz`.
pub fn resolve_relative(spec: &str, now: DateTime<Utc>, tz: Tz) -> Result<(String, String), String> {
    let today = now.with_timezone(&tz).date_naive();
    let words: Vec<String> = spec
        .to_lowercase()
        .replace('_', " ")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let words: Vec<&str> = words.iter().map(String::as_str).collect();

    let (from, to): (NaiveDate, NaiveDate) = match words.as_slice() {
        ["today"] => (today, today + Duration::days(1)),
        ["yesterday"] => (today - Duration::days(1), today),
        ["ytd"] | ["year", "to", "date"] => {
            (period_start(today, Unit::Year), today + Duration::days(1))
        }
        ["this", unit] => {
            let unit = parse_unit(unit).ok_or_else(|| unknown(spec))?;
            let start = period_start(today, unit);
            (start, shift_period_start(start, unit, 1))
        }
        // "previous <unit>" — and "last <unit>" with no number means the same.
        ["previous", unit] | ["last", unit] if parse_unit(unit).is_some() => {
            let unit = parse_unit(unit).ok_or_else(|| unknown(spec))?;
            let current = period_start(today, unit);
            (shift_period_start(current, unit, -1), current)
        }
        // "last N <unit>" — the current period plus the N−1 before it.
        ["last", n, unit] => {
            let n: i32 = n.parse().map_err(|_| unknown(spec))?;
            if n < 1 {
                return Err(unknown(spec));
            }
            let unit = parse_unit(unit).ok_or_else(|| unknown(spec))?;
            let current = period_start(today, unit);
            (
                shift_period_start(current, unit, -(n - 1)),
                shift_period_start(current, unit, 1),
            )
        }
        _ => return Err(unknown(spec)),
    };

    Ok((day_to_utc(from, tz), day_to_utc(to, tz)))
}

fn unknown(spec: &str) -> String {
    format!(
        "unrecognized date range '{spec}' — accepted: today, yesterday, ytd, \
         'last N days|weeks|months|quarters|years', 'this <unit>', 'previous <unit>'"
    )
}

/// Midnight of `date` in `tz`, as a UTC RFC3339 instant. DST gaps resolve to
/// the earliest valid local time.
fn day_to_utc(date: NaiveDate, tz: Tz) -> String {
    let naive = date.and_hms_opt(0, 0, 0).expect("midnight exists");
    let local = tz
        .from_local_datetime(&naive)
        .earliest()
        .unwrap_or_else(|| tz.from_utc_datetime(&naive));
    local.with_timezone(&Utc).to_rfc3339()
}

/// Parse an IANA timezone name (default UTC when absent/empty).
pub fn parse_tz(name: Option<&str>) -> Result<Tz, String> {
    match name.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(chrono_tz::UTC),
        Some(name) => name
            .parse::<Tz>()
            .map_err(|_| format!("unknown timezone '{name}' (expected an IANA name like 'Europe/London')")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().expect("test clock parses")
    }

    #[test]
    fn last_n_days_includes_today() {
        // Sat 2026-08-09, UTC.
        let (from, to) = resolve_relative("last 30 days", at("2026-08-09T14:30:00Z"), chrono_tz::UTC).unwrap();
        assert_eq!(from, "2026-07-11T00:00:00+00:00");
        assert_eq!(to, "2026-08-10T00:00:00+00:00");
    }

    #[test]
    fn this_month_and_previous_quarter_are_calendar_aligned() {
        let now = at("2026-08-09T14:30:00Z");
        let (from, to) = resolve_relative("this month", now, chrono_tz::UTC).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2026-08-01T00:00:00+00:00", "2026-09-01T00:00:00+00:00"));
        let (from, to) = resolve_relative("previous quarter", now, chrono_tz::UTC).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2026-04-01T00:00:00+00:00", "2026-07-01T00:00:00+00:00"));
    }

    #[test]
    fn bare_last_month_means_previous_month() {
        let (from, to) = resolve_relative("last month", at("2026-08-09T00:00:00Z"), chrono_tz::UTC).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2026-07-01T00:00:00+00:00", "2026-08-01T00:00:00+00:00"));
    }

    #[test]
    fn ytd_and_this_week_iso_monday() {
        let now = at("2026-08-09T14:30:00Z"); // a Sunday
        let (from, to) = resolve_relative("ytd", now, chrono_tz::UTC).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2026-01-01T00:00:00+00:00", "2026-08-10T00:00:00+00:00"));
        let (from, _) = resolve_relative("this week", now, chrono_tz::UTC).unwrap();
        assert_eq!(from, "2026-08-03T00:00:00+00:00"); // Monday
    }

    #[test]
    fn timezone_moves_the_day_boundary() {
        // 01:00 UTC on Aug 9 is still Aug 8 in Los Angeles (UTC-7).
        let now = at("2026-08-09T01:00:00Z");
        let tz: Tz = "America/Los_Angeles".parse().unwrap();
        let (from, to) = resolve_relative("today", now, tz).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2026-08-08T07:00:00+00:00", "2026-08-09T07:00:00+00:00"));
        let (utc_from, _) = resolve_relative("today", now, chrono_tz::UTC).unwrap();
        assert_eq!(utc_from, "2026-08-09T00:00:00+00:00");
    }

    #[test]
    fn month_arithmetic_survives_year_boundaries() {
        let (from, to) = resolve_relative("last 3 months", at("2026-01-15T00:00:00Z"), chrono_tz::UTC).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("2025-11-01T00:00:00+00:00", "2026-02-01T00:00:00+00:00"));
    }

    #[test]
    fn junk_is_rejected_with_the_accepted_forms() {
        let err = resolve_relative("sometime recently", at("2026-08-09T00:00:00Z"), chrono_tz::UTC).unwrap_err();
        assert!(err.contains("accepted:"), "err: {err}");
        assert!(resolve_relative("last 0 days", at("2026-08-09T00:00:00Z"), chrono_tz::UTC).is_err());
    }

    #[test]
    fn parse_tz_defaults_to_utc_and_rejects_junk() {
        assert_eq!(parse_tz(None).unwrap(), chrono_tz::UTC);
        assert_eq!(parse_tz(Some("Europe/London")).unwrap().name(), "Europe/London");
        assert!(parse_tz(Some("Mars/Olympus")).is_err());
    }
}
