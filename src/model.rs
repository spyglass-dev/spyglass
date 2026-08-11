//! The Cube-style data model — how metrics and measures are defined.
//!
//! A [`Model`] is a set of [`Cube`]s. Each cube maps to one base relation
//! (`sql_table`, or an inline `sql` subquery) and declares **measures**
//! (aggregations) and **dimensions** (group-by / filter columns). This mirrors
//! Cube's modeling format closely enough that definitions are portable, while
//! staying a small, dependency-light Rust struct we own.
//!
//! Definitions are authored as YAML/JSON and loaded by [`crate::loader`].

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A whole reporting model: named cubes. `BTreeMap` keeps iteration
/// deterministic (important for stable compiled SQL + tests).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Model {
    #[serde(default)]
    pub cubes: BTreeMap<String, Cube>,
}

impl Model {
    pub fn cube(&self, name: &str) -> Option<&Cube> {
        self.cubes.get(name)
    }

    /// Merge another model's cubes in (later wins). Used to layer host
    /// (Zippy) cubes on top of base ones, or to load a directory of files.
    pub fn merge(&mut self, other: Model) {
        for (k, v) in other.cubes {
            self.cubes.insert(k, v);
        }
    }

    /// Check cross-references the type system can't: join targets exist,
    /// label targets resolve to a declared dimension, `drill_members` name
    /// declared dimensions, and a measure's `drill_members` never widens the
    /// cube's. Call after the FULL model is assembled (references may span
    /// files) — `load_dir` does; hosts embedding a single parsed file should
    /// call it themselves. Returns every problem, not just the first.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut problems: Vec<String> = Vec::new();
        // A drill member may be a local dimension key or a qualified member.
        let resolves = |cube: &Cube, member: &str| -> bool {
            match member.split_once('.') {
                Some((c, field)) => self
                    .cube(c)
                    .is_some_and(|cb| cb.dimensions.contains_key(field)),
                None => cube.dimensions.contains_key(member),
            }
        };
        for (name, cube) in &self.cubes {
            for target in cube.joins.keys() {
                if self.cube(target).is_none() {
                    problems.push(format!("{name}: join target '{target}' is not a cube"));
                }
            }
            for (dim_name, dim) in &cube.dimensions {
                if let Some(label) = &dim.label {
                    if !resolves(cube, label) {
                        problems.push(format!(
                            "{name}.{dim_name}: label '{label}' does not resolve to a declared dimension"
                        ));
                    }
                }
            }
            for member in &cube.drill_members {
                if !resolves(cube, member) {
                    problems.push(format!(
                        "{name}: drill member '{member}' does not resolve to a declared dimension"
                    ));
                }
            }
            for (measure_name, measure) in &cube.measures {
                if let Some(members) = &measure.drill_members {
                    for member in members {
                        if !cube.drill_members.contains(member) {
                            problems.push(format!(
                                "{name}.{measure_name}: drill member '{member}' is not in the \
                                 cube's drill_members — a measure may narrow the cube's list, \
                                 never widen it"
                            ));
                        }
                    }
                }
                let refs = measure
                    .sql
                    .as_deref()
                    .map(|sql| calculated_refs(cube, sql))
                    .unwrap_or_default();
                if !refs.is_empty() && measure.measure_type != MeasureType::Number {
                    problems.push(format!(
                        "{name}.{measure_name}: ${{Cube.measure}} interpolation is only \
                         supported in `number` measures (aggregates cannot nest)"
                    ));
                }
                for r in refs {
                    if !cube.measures.contains_key(r) {
                        problems.push(format!(
                            "{name}.{measure_name}: interpolated member '{r}' is not a measure \
                             of this cube"
                        ));
                    }
                }
            }
            // Calculated-measure cycles: DFS over the ${CUBE.m} reference
            // graph. A cycle would recurse forever at compile time; catching
            // it here means a bad model never loads.
            for start in cube.measures.keys() {
                let mut stack = vec![start.as_str()];
                let mut path: Vec<&str> = Vec::new();
                fn dfs<'a>(
                    cube: &'a Cube,
                    current: &'a str,
                    path: &mut Vec<&'a str>,
                    problems: &mut Vec<String>,
                    cube_name: &str,
                ) {
                    if path.contains(&current) {
                        problems.push(format!(
                            "{cube_name}: calculated-measure cycle through '{current}' ({})",
                            path.join(" -> ")
                        ));
                        return;
                    }
                    path.push(current);
                    if let Some(m) = cube.measures.get(current) {
                        if let Some(sql) = &m.sql {
                            for r in calculated_refs(cube, sql) {
                                dfs(cube, r, path, problems, cube_name);
                            }
                        }
                    }
                    path.pop();
                }
                let before = problems.len();
                dfs(
                    cube,
                    stack.pop().expect("start"),
                    &mut path,
                    &mut problems,
                    name,
                );
                // One report per cycle is enough; skip the remaining starts
                // once a cycle in this cube is found.
                if problems.len() > before {
                    break;
                }
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }
}

/// One cube — a queryable entity backed by a base relation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cube {
    /// Cube name (also the member prefix, e.g. `Submissions.count`). Under a
    /// `cubes:` map it's backfilled from the map key by the loader, so cube
    /// definitions don't repeat it; a single-cube file sets it explicitly.
    #[serde(default)]
    pub name: String,
    /// Base table name. Exactly one of `sql_table` / `sql` should be set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql_table: Option<String>,
    /// Inline base SQL (a subquery), used when there's no single table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub measures: BTreeMap<String, Measure>,
    #[serde(default)]
    pub dimensions: BTreeMap<String, Dimension>,
    /// Joins to other cubes, keyed by target cube name. Only `many_to_one` /
    /// `one_to_one` edges are traversable; a `one_to_many` edge documents the
    /// relationship but any query traversing it is a compile error ([`FanOut`]
    /// (crate::compiler::CompileError::FanOut)) — it would duplicate measure
    /// rows and silently inflate every aggregate.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub joins: BTreeMap<String, Join>,
    /// Row-mode allowlist: the members (local dimension keys or qualified
    /// `Cube.member` names) a row-level query may project. Deliberately also
    /// the PII boundary — row mode can only ever reveal what a cube explicitly
    /// published here. Empty = row mode unavailable for this cube.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drill_members: Vec<String>,
    /// Named reusable predicates (`segments: { paying: { sql: "${CUBE}.plan
    /// <> 'free'" } }`), queried as `"segments": ["Cube.paying"]`. One token
    /// for an agent instead of a filter blob, and a place to put business
    /// definitions so they stop being re-derived per report.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub segments: BTreeMap<String, Segment>,
}

/// A named predicate on a cube's rows. `${CUBE}` (or any `${CubeName}`)
/// resolves to the cube's alias in the compiled SQL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub sql: String,
    /// One sentence of business definition, shown in the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// How a join edge relates the declaring cube's rows to the target's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinRelationship {
    /// Many declaring rows → one target row. Safe to traverse (no fan-out).
    ManyToOne,
    /// One declaring row → one target row. Safe to traverse.
    OneToOne,
    /// One declaring row → many target rows. Declarable for documentation,
    /// never traversable: it would multiply the base cube's rows.
    OneToMany,
}

/// A join edge to another cube.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Join {
    pub relationship: JoinRelationship,
    /// Join condition. `${CUBE}` refers to the declaring cube; `${Other}`
    /// (any cube name) refers to that cube — both resolve to the quoted cube
    /// alias, e.g. `"${CUBE}.workspace_id = ${Workspaces}.workspace_id"`.
    pub sql: String,
}

impl Cube {
    /// The `FROM` source for this cube (table name or `(sql)`).
    pub fn from_source(&self) -> Option<String> {
        if let Some(t) = &self.sql_table {
            Some(t.clone())
        } else {
            self.sql.as_ref().map(|s| format!("({s})"))
        }
    }
}

/// How a measure aggregates. Mirrors Cube's measure types.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasureType {
    #[default]
    Count,
    CountDistinct,
    Sum,
    Avg,
    Min,
    Max,
    /// A raw numeric expression with no aggregation wrapper.
    Number,
}

/// A measure: an aggregation over the cube's rows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Measure {
    #[serde(rename = "type")]
    pub measure_type: MeasureType,
    /// Column/expression to aggregate. Omitted for `count`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Display format hint for the UI (e.g. `percent`, `number`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Narrows the cube's `drill_members` for row-mode queries reached through
    /// this measure. May only ever be a subset — a measure narrows the cube's
    /// published record shape, it never widens it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drill_members: Option<Vec<String>>,
    /// One sentence of definition, shown in the catalog and read by agents.
    /// "Average score" is exactly the kind of number that needs one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Surface this member first in catalogs and digests.
    #[serde(default, skip_serializing_if = "is_false")]
    pub featured: bool,
    /// Omit this member from the public catalog (`/meta`). It stays
    /// queryable by name — hidden curates discovery, it is not security.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    /// Unit label for display (e.g. `students`, `points`, `%`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// Whether filter UIs should offer this member (for measures this only
    /// becomes meaningful once measure filters compile to HAVING).
    #[serde(default, skip_serializing_if = "is_false")]
    pub filterable: bool,
}

/// Dimension value type.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionType {
    #[default]
    String,
    Number,
    Time,
    Boolean,
}

/// A dimension: a column to group by or filter on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Dimension {
    #[serde(rename = "type")]
    pub dimension_type: DimensionType,
    /// Column/expression. Defaults to the dimension key if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Marks the tenant/scope column (e.g. `workspace_id`). The security
    /// context's scope filters are matched against members; this flag lets
    /// callers/tools discover which dimension carries the tenant.
    #[serde(default, skip_serializing_if = "is_false")]
    pub tenant: bool,
    /// Member whose value is DISPLAYED for this dimension (e.g. an id
    /// dimension labelled by a joined cube's name column: `label:
    /// Workspaces.workspace_name`, or an unqualified same-cube dimension).
    /// Auto-projected as `"{member}__label"` whenever the dimension is
    /// selected; sorting, filtering and grouping still act on the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// What a click on this dimension's value MEANS — the entity it
    /// identifies. The UI emits a typed `DrillEvent { member, value, label,
    /// entity }`; hosts route entities they know, and the default with no
    /// router is drill-down-in-place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drill: Option<DrillTarget>,
    /// One sentence of definition, shown in the catalog and read by agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Surface this member first in catalogs and digests.
    #[serde(default, skip_serializing_if = "is_false")]
    pub featured: bool,
    /// Omit this member from the public catalog (`/meta`). It stays
    /// queryable by name — hidden curates discovery, it is not security.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    /// Unit label for display (rarely useful on dimensions; kept for
    /// symmetry with measures).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    /// Whether filter UIs (and the `/values` distinct-value endpoint, once it
    /// exists) should offer this dimension. The allowlist for facets.
    #[serde(default, skip_serializing_if = "is_false")]
    pub filterable: bool,
}

/// A dimension's drill annotation: the entity a click resolves to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrillTarget {
    pub entity: String,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The `${…}` token contents of a SQL fragment, in order.
pub(crate) fn sql_refs(sql: &str) -> Vec<&str> {
    let mut refs = Vec::new();
    let mut rest = sql;
    while let Some(start) = rest.find("${") {
        let Some(len) = rest[start + 2..].find('}') else {
            break;
        };
        refs.push(&rest[start + 2..start + 2 + len]);
        rest = &rest[start + 2 + len + 1..];
    }
    refs
}

/// The measures a calculated (`number`) measure's SQL references on its own
/// cube — `${CUBE.m}` or `${<CubeName>.m}` tokens. `${CUBE}` alone (the
/// alias) is not a measure reference.
pub(crate) fn calculated_refs<'a>(cube: &Cube, sql: &'a str) -> Vec<&'a str> {
    sql_refs(sql)
        .into_iter()
        .filter_map(|token| {
            let (target, member) = token.split_once('.')?;
            (target == "CUBE" || target == cube.name).then_some(member)
        })
        .collect()
}
