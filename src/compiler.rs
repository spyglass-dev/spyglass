//! The query compiler — turns a [`Query`] + [`Model`] + [`SecurityContext`]
//! into a parameterized SQL statement. Pure (no I/O), so it's fully
//! unit-tested without a database. Engines execute the result.
//!
//! Queries target one **base cube** — the cube owning the measures (or the
//! first dimension's cube when measureless). Dimensions and filters may reach
//! other cubes through declared `joins:`; the compiler traverses
//! `many_to_one` / `one_to_one` edges away from the base as `LEFT JOIN`s. A
//! `one_to_many` traversal is a compile error ([`CompileError::FanOut`]) —
//! it would duplicate base rows and silently inflate every aggregate, and a
//! wrong number is worse than a missing capability. Values are always bound
//! as `$n` parameters — never string-interpolated — so the compiled SQL is
//! injection-safe by construction.

use crate::context::SecurityContext;
use crate::model::{Cube, DimensionType, Join, JoinRelationship, MeasureType, Model};
use crate::query::{Column, Filter, FilterOperator, Query, QueryMode, ScalarValue};
use std::borrow::Cow;
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("query references no members")]
    Empty,
    #[error("query's measures span multiple cubes ({0:?}); all measures must belong to one cube")]
    MultipleCubes(Vec<String>),
    #[error("unknown cube '{0}'")]
    UnknownCube(String),
    #[error("unknown member '{0}'")]
    UnknownMember(String),
    #[error("cube '{0}' has no base table or sql")]
    NoSource(String),
    #[error("filter on measure '{0}' is not supported in row mode (no aggregates to compare)")]
    MeasureFilter(String),
    #[error("operator requires exactly one value: '{0}'")]
    NeedsOneValue(String),
    #[error(
        "cube '{cube}' requires a tenant scope for '{cube}.{dimension}' — refusing to run \
         an unscoped query (set SecurityContext::allow_unscoped for admin/offline reads)"
    )]
    MissingTenantScope { cube: String, dimension: String },
    #[error(
        "no join path from '{from}' to '{to}' — declare a `joins:` edge or query the cube directly"
    )]
    NoJoinPath { from: String, to: String },
    #[error(
        "joining '{from}' to '{to}' traverses a one_to_many relationship, which would duplicate \
         '{from}' rows and inflate every aggregate — declare the query on '{to}' instead"
    )]
    FanOut { from: String, to: String },
    #[error("row mode takes no measures (got '{0}') — request dimensions only")]
    RowsWithMeasures(String),
    #[error("{0}")]
    BadDateRange(String),
    #[error("{0}")]
    BadTimezone(String),
    #[error(
        "query uses a relative date range ('{0}') but compile() has no clock — use compile_at() \
         with an explicit 'now' (the engine does this; the compiler never reads system time)"
    )]
    RelativeDateNeedsClock(String),
    #[error(
        "cube '{0}' declares no drill_members, so row mode is unavailable — the cube has not \
         published a record shape"
    )]
    NoDrillMembers(String),
    #[error("fill_gaps: {0}")]
    BadFillGaps(String),
    #[error("compare: {0}")]
    BadCompare(String),
    #[error(
        "calculated-measure cycle through '{0}' — load-time validation should have caught this"
    )]
    CalculatedCycle(String),
    #[error(
        "dimension '{0}' is not marked `filterable: true` — /values serves only the model's \
         declared facet allowlist"
    )]
    NotFilterable(String),
}

/// A compiled, parameterized statement ready for an engine to execute.
#[derive(Debug, Clone)]
pub struct Compiled {
    pub sql: String,
    pub params: Vec<ScalarValue>,
    pub columns: Vec<Column>,
}

/// Alias of the `include_total` window column. The engine strips it from
/// rows/columns and surfaces it as `QueryResult.total`.
pub const TOTAL_ALIAS: &str = "__total";

/// The SQL dialect a statement is compiled for.
///
/// One compiler, parameterized where the dialects genuinely differ —
/// placeholder syntax, casts, and text coercion — rather than a compiler per
/// engine, which would be N copies of the join planner and N places for the
/// fail-closed tenant rule to drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dialect {
    /// `$n` placeholders, `::type` casts. The default.
    #[default]
    Postgres,
    /// `{pn:String}` server-side parameters (the HTTP interface's syntax);
    /// every parameter is declared as `String` and coerced in SQL —
    /// `toFloat64(...)`, `parseDateTimeBestEffort(...)` — mirroring the
    /// Postgres engine's bind-as-text-and-cast strategy.
    ClickHouse,
}

fn split_member(member: &str) -> Result<(&str, &str), CompileError> {
    member
        .split_once('.')
        .ok_or_else(|| CompileError::UnknownMember(member.to_string()))
}

/// The cubes a query touches: the base plus every cube reached by a join
/// edge, with the edges in deterministic emission order.
struct JoinPlan<'a> {
    base: &'a Cube,
    /// `(from, to, edge)` in LEFT JOIN emission order (parents before
    /// children). Empty for a single-cube query.
    edges: Vec<(&'a Cube, &'a Cube, &'a Join)>,
}

impl<'a> JoinPlan<'a> {
    fn has_joins(&self) -> bool {
        !self.edges.is_empty()
    }

    /// All participating cubes, base first, then join order.
    fn cubes(&self) -> Vec<&'a Cube> {
        let mut cubes = vec![self.base];
        for (_, to, _) in &self.edges {
            if !cubes.iter().any(|c| c.name == to.name) {
                cubes.push(to);
            }
        }
        cubes
    }

    /// Resolve a member's owning cube — it must be participating.
    fn cube_for(&self, member: &str) -> Result<&'a Cube, CompileError> {
        let (name, _) = split_member(member)?;
        self.cubes()
            .into_iter()
            .find(|c| c.name == name)
            .ok_or_else(|| CompileError::UnknownCube(name.to_string()))
    }
}

/// Referenced cube names in first-reference order: measures, then dimensions,
/// time dimensions, filters, then selected dimensions' label targets.
fn referenced_cubes(model: &Model, query: &Query) -> Result<Vec<String>, CompileError> {
    let mut names: Vec<String> = Vec::new();
    let mut push = |m: &str| -> Result<(), CompileError> {
        let (cube, _) = split_member(m)?;
        if !names.iter().any(|n| n == cube) {
            names.push(cube.to_string());
        }
        Ok(())
    };
    for m in query.members() {
        push(m)?;
    }
    for f in &query.filters {
        push(&f.member)?;
    }
    // A segment's cube participates like any referenced cube — its joins are
    // planned and, crucially, its tenant scope is enforced.
    for s in &query.segments {
        push(s)?;
    }
    // A selected dimension's label pulls the label's cube into the query even
    // when nothing else references it — that is the point of labels.
    for member in &query.dimensions {
        let (cube_name, field) = split_member(member)?;
        if let Some(cube) = model.cube(cube_name) {
            if let Some(dim) = cube.dimensions.get(field) {
                if let Some(label) = &dim.label {
                    if label.contains('.') {
                        push(label)?;
                    }
                }
            }
        }
    }
    if names.is_empty() {
        return Err(CompileError::Empty);
    }
    Ok(names)
}

/// Pick the base cube and plan the joins. The base is the cube owning the
/// query's measures (all measures must share it), or the first referenced
/// cube for a measureless query. Every other referenced cube must be
/// reachable from the base over `many_to_one` / `one_to_one` edges; an edge
/// that is `one_to_many` fails with [`CompileError::FanOut`].
fn plan_joins<'a>(model: &'a Model, query: &Query) -> Result<JoinPlan<'a>, CompileError> {
    let referenced = referenced_cubes(model, query)?;

    let mut measure_cubes: Vec<String> = Vec::new();
    for m in &query.measures {
        let (cube, _) = split_member(m)?;
        if !measure_cubes.iter().any(|n| n == cube) {
            measure_cubes.push(cube.to_string());
        }
    }
    if measure_cubes.len() > 1 {
        return Err(CompileError::MultipleCubes(measure_cubes));
    }
    let base_name = measure_cubes
        .first()
        .cloned()
        .unwrap_or_else(|| referenced[0].clone());
    let base = model
        .cube(&base_name)
        .ok_or_else(|| CompileError::UnknownCube(base_name.clone()))?;

    let needed: Vec<&String> = referenced.iter().filter(|n| **n != base_name).collect();
    if needed.is_empty() {
        return Ok(JoinPlan {
            base,
            edges: Vec::new(),
        });
    }

    // BFS from the base over traversable edges. `parent` remembers how each
    // cube was reached; `blocked` remembers one_to_many edges we refused, so
    // the error can say "fan-out" rather than "no path".
    let mut parent: BTreeMap<String, (String, &Join)> = BTreeMap::new();
    let mut blocked: BTreeMap<String, String> = BTreeMap::new();
    let mut queue: Vec<String> = vec![base_name.clone()];
    let mut i = 0;
    while i < queue.len() {
        let from_name = queue[i].clone();
        i += 1;
        let from = model
            .cube(&from_name)
            .ok_or_else(|| CompileError::UnknownCube(from_name.clone()))?;
        for (to_name, join) in &from.joins {
            if to_name == &base_name || parent.contains_key(to_name) {
                continue;
            }
            if join.relationship == JoinRelationship::OneToMany {
                blocked.entry(to_name.clone()).or_insert(from_name.clone());
                continue;
            }
            parent.insert(to_name.clone(), (from_name.clone(), join));
            queue.push(to_name.clone());
        }
    }

    // Emit each needed cube's path, parents first, deduplicated.
    let mut edges: Vec<(&Cube, &Cube, &Join)> = Vec::new();
    for target in needed {
        if !parent.contains_key(target) {
            if let Some(from) = blocked.get(target) {
                return Err(CompileError::FanOut {
                    from: from.clone(),
                    to: target.clone(),
                });
            }
            return Err(CompileError::NoJoinPath {
                from: base_name.clone(),
                to: target.clone(),
            });
        }
        let mut chain: Vec<(String, String, &Join)> = Vec::new();
        let mut cursor = target.clone();
        while let Some((from, join)) = parent.get(&cursor) {
            chain.push((from.clone(), cursor.clone(), *join));
            cursor = from.clone();
        }
        for (from_name, to_name, join) in chain.into_iter().rev() {
            if edges.iter().any(|(_, to, _)| to.name == to_name) {
                continue;
            }
            let from = model
                .cube(&from_name)
                .ok_or_else(|| CompileError::UnknownCube(from_name.clone()))?;
            let to = model
                .cube(&to_name)
                .ok_or_else(|| CompileError::UnknownCube(to_name.clone()))?;
            edges.push((from, to, join));
        }
    }
    Ok(JoinPlan { base, edges })
}

/// True for a bare column name that must be qualified in a joined query.
fn is_simple_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Resolve a model SQL fragment against its owning cube: `${CUBE}` becomes
/// the cube's quoted alias, and — only when the query has joins, so existing
/// single-cube SQL stays byte-identical — a bare column name is qualified
/// with the alias to keep it unambiguous across joined relations.
fn qualify_expr(raw: &str, cube: &Cube, has_joins: bool) -> String {
    let alias = quote(&cube.name);
    let replaced = raw.replace("${CUBE}", &alias);
    if has_joins && is_simple_ident(&replaced) {
        format!("{alias}.{replaced}")
    } else {
        replaced
    }
}

/// Interpolate a join condition: `${CUBE}` is the declaring cube's alias and
/// `${Name}` is any cube's alias.
fn join_condition(sql: &str, declaring: &Cube, model: &Model) -> String {
    let mut out = sql.replace("${CUBE}", &quote(&declaring.name));
    for name in model.cubes.keys() {
        out = out.replace(&format!("${{{name}}}"), &quote(name));
    }
    out
}

fn dimension_expr(
    cube: &Cube,
    field: &str,
    has_joins: bool,
) -> Result<(String, DimensionType), CompileError> {
    let d = cube
        .dimensions
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(format!("{}.{}", cube.name, field)))?;
    let raw = d.sql.clone().unwrap_or_else(|| field.to_string());
    Ok((qualify_expr(&raw, cube, has_joins), d.dimension_type))
}

fn measure_expr(
    cube: &Cube,
    field: &str,
    has_joins: bool,
    dialect: Dialect,
) -> Result<String, CompileError> {
    measure_expr_guarded(cube, field, has_joins, dialect, &mut Vec::new())
}

fn measure_expr_guarded(
    cube: &Cube,
    field: &str,
    has_joins: bool,
    dialect: Dialect,
    stack: &mut Vec<String>,
) -> Result<String, CompileError> {
    let m = cube
        .measures
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(format!("{}.{}", cube.name, field)))?;
    // A `number` measure's SQL may interpolate `${CUBE.measure}` — resolved
    // to the referenced measure's COMPILED aggregate expression, recursively.
    // This is what makes ratios like `${CUBE.published} / nullif(${CUBE.count}, 0)`
    // declarable. Only declared members interpolate, so injection-safety is
    // preserved by construction; cycles are refused (validated at load too).
    let sql = match (&m.sql, m.measure_type) {
        (Some(sql), MeasureType::Number) => Some(interpolate_measures(
            cube, field, sql, has_joins, dialect, stack,
        )?),
        (Some(sql), _) => Some(qualify_expr(sql, cube, has_joins)),
        (None, _) => None,
    };
    // Cast numeric aggregates to a double so engines get a predictable type.
    let float = |expr: String| match dialect {
        Dialect::Postgres => format!("{expr}::float8"),
        Dialect::ClickHouse => format!("toFloat64({expr})"),
    };
    Ok(match m.measure_type {
        MeasureType::Count => "count(*)".to_string(),
        MeasureType::CountDistinct => {
            format!("count(distinct {})", sql.unwrap_or_else(|| "*".to_string()))
        }
        MeasureType::Sum => float(format!("sum({})", req_sql(sql, field)?)),
        MeasureType::Avg => float(format!("avg({})", req_sql(sql, field)?)),
        MeasureType::Min => float(format!("min({})", req_sql(sql, field)?)),
        MeasureType::Max => float(format!("max({})", req_sql(sql, field)?)),
        MeasureType::Number => float(format!("({})", req_sql(sql, field)?)),
    })
}

/// Replace `${CUBE.m}` / `${<OwnCube>.m}` tokens with the referenced
/// measure's compiled expression. `${CUBE}` (no member) stays for
/// `qualify_expr` to turn into the alias; any other token is refused.
fn interpolate_measures(
    cube: &Cube,
    field: &str,
    sql: &str,
    has_joins: bool,
    dialect: Dialect,
    stack: &mut Vec<String>,
) -> Result<String, CompileError> {
    if stack.iter().any(|f| f == field) {
        return Err(CompileError::CalculatedCycle(format!(
            "{}.{}",
            cube.name, field
        )));
    }
    stack.push(field.to_string());
    let mut out = String::new();
    let mut rest = sql;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(len) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let token = &after[..len];
        match token.split_once('.') {
            Some((target, member)) if target == "CUBE" || target == cube.name => {
                out.push_str(&measure_expr_guarded(
                    cube, member, has_joins, dialect, stack,
                )?);
            }
            None if token == "CUBE" => out.push_str("${CUBE}"),
            _ => {
                stack.pop();
                return Err(CompileError::UnknownMember(format!(
                    "${{{token}}} in {}.{field} — only ${{CUBE.<measure>}} of the same cube \
                     may be interpolated",
                    cube.name
                )));
            }
        }
        rest = &after[len + 1..];
    }
    out.push_str(rest);
    stack.pop();
    Ok(qualify_expr(&out, cube, has_joins))
}

fn req_sql(sql: Option<String>, field: &str) -> Result<String, CompileError> {
    sql.ok_or_else(|| CompileError::UnknownMember(format!("{field} requires `sql`")))
}

/// Quote an identifier alias (the `Cube.member` key).
fn quote(alias: &str) -> String {
    format!("\"{}\"", alias.replace('"', "\"\""))
}

/// Cast appended to a bind placeholder. The engine binds every parameter as
/// **text** (so tokio-postgres never mis-infers an `int4`/`timestamptz` column
/// from an `i64`/`String` value); this casts it back to the column's type.
/// Text columns need no cast.
fn cast_for(dim_type: DimensionType) -> &'static str {
    match dim_type {
        DimensionType::String => "",
        DimensionType::Number => "::numeric",
        DimensionType::Time => "::timestamptz",
        DimensionType::Boolean => "::boolean",
    }
}

/// A bind placeholder with the type coercion for `dim_type`.
///
/// Both dialects follow the same strategy — every parameter travels as text
/// and the statement coerces it to the column's type — so the two arms differ
/// in syntax, never in meaning. ClickHouse parameters are `{pn:String}` (the
/// server-side parameter syntax its HTTP interface binds, never interpolated),
/// and `parseDateTimeBestEffort` is what accepts the same ISO-8601 strings
/// Postgres's `::timestamptz` does.
fn placeholder(idx: usize, dim_type: DimensionType, dialect: Dialect) -> String {
    match dialect {
        Dialect::Postgres => format!("${}{}", idx, cast_for(dim_type)),
        Dialect::ClickHouse => {
            let p = format!("{{p{idx}:String}}");
            match dim_type {
                DimensionType::String => p,
                DimensionType::Number => format!("toFloat64({p})"),
                DimensionType::Time => format!("parseDateTimeBestEffort({p})"),
                DimensionType::Boolean => format!("({p} = 'true')"),
            }
        }
    }
}

/// Project an expression as text — the coercion behind time buckets and
/// `contains` matching.
fn as_text(expr: &str, dialect: Dialect) -> String {
    match dialect {
        Dialect::Postgres => format!("{expr}::text"),
        Dialect::ClickHouse => format!("toString({expr})"),
    }
}

/// Normalize a `mode: rows` query: no measures, and the projection becomes
/// the requested dimensions ∩ the base cube's `drill_members` (all of them
/// when none are requested). `drill_members` is the cube's published record
/// shape AND its PII boundary — row mode can never reveal more than it.
fn normalize_rows_mode<'q>(
    model: &Model,
    query: &'q Query,
) -> Result<Cow<'q, Query>, CompileError> {
    if query.mode != QueryMode::Rows {
        return Ok(Cow::Borrowed(query));
    }
    if let Some(m) = query.measures.first() {
        return Err(CompileError::RowsWithMeasures(m.clone()));
    }
    let plan = plan_joins(model, query)?;
    let base = plan.base;
    if base.drill_members.is_empty() {
        return Err(CompileError::NoDrillMembers(base.name.clone()));
    }
    // Qualify local drill-member keys; qualified entries pass through.
    let allowed: Vec<String> = base
        .drill_members
        .iter()
        .map(|m| {
            if m.contains('.') {
                m.clone()
            } else {
                format!("{}.{}", base.name, m)
            }
        })
        .collect();
    let dimensions: Vec<String> = if query.dimensions.is_empty() {
        allowed
    } else {
        query
            .dimensions
            .iter()
            .filter(|d| allowed.iter().any(|a| a == *d))
            .cloned()
            .collect()
    };
    if dimensions.is_empty() {
        return Err(CompileError::Empty);
    }
    let mut normalized = query.clone();
    normalized.dimensions = dimensions;
    Ok(Cow::Owned(normalized))
}

/// Compile the distinct-values query behind `/values`: scope-filtered,
/// label-resolved values of one `filterable: true` dimension, with counts.
/// Pure, like `compile` — and the same tenant rules apply: the dimension's
/// cube (and its label's cube, when joined) must be scoped or the query is
/// refused. The `filterable` flag is the allowlist: `/values` never serves a
/// dimension the model didn't explicitly offer for filtering.
pub fn compile_values(
    model: &Model,
    member: &str,
    search: Option<&str>,
    limit: Option<u32>,
    ctx: &SecurityContext,
) -> Result<Compiled, CompileError> {
    compile_values_for(model, member, search, limit, ctx, Dialect::Postgres)
}

/// [`compile_values`] for a specific [`Dialect`].
pub fn compile_values_for(
    model: &Model,
    member: &str,
    search: Option<&str>,
    limit: Option<u32>,
    ctx: &SecurityContext,
    dialect: Dialect,
) -> Result<Compiled, CompileError> {
    let (_, field) = split_member(member)?;
    // A synthetic single-dimension query drives join planning (the label's
    // cube joins in automatically) and scope enforcement.
    let synthetic = Query {
        dimensions: vec![member.to_string()],
        ..Default::default()
    };
    let plan = plan_joins(model, &synthetic)?;
    let cube = plan.base;
    let dim = cube
        .dimensions
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(member.to_string()))?;
    if !dim.filterable {
        return Err(CompileError::NotFilterable(member.to_string()));
    }
    let has_joins = plan.has_joins();
    let (value_expr, _) = dimension_expr(cube, field, has_joins)?;

    let mut select = vec![format!("{} as {}", value_expr, quote("value"))];
    let mut group_by = vec![value_expr.clone()];
    let mut columns = vec![Column::new("value", "dimension")];
    let mut label_expr: Option<String> = None;
    if let Some(label) = &dim.label {
        let (label_cube, label_field) = if label.contains('.') {
            let (_, f) = split_member(label)?;
            (plan.cube_for(label)?, f)
        } else {
            (cube, label.as_str())
        };
        let (expr, _) = dimension_expr(label_cube, label_field, has_joins)?;
        select.push(format!("{} as {}", expr, quote("label")));
        group_by.push(expr.clone());
        columns.push(Column::new("label", "label"));
        label_expr = Some(expr);
    }
    select.push(format!("count(*) as {}", quote("count")));
    columns.push(Column::new("count", "measure"));

    let mut params: Vec<ScalarValue> = Vec::new();
    let mut where_parts: Vec<String> = Vec::new();
    // Typeahead search matches what the user SEES: the label when the
    // dimension has one, the raw value otherwise.
    if let Some(s) = search.map(str::trim).filter(|s| !s.is_empty()) {
        let target = label_expr.as_deref().unwrap_or(&value_expr);
        params.push(ScalarValue::String(format!("%{s}%")));
        where_parts.push(format!(
            "{} ilike {}",
            as_text(target, dialect),
            placeholder(params.len(), DimensionType::String, dialect)
        ));
    }
    apply_scope(
        &plan,
        ctx,
        has_joins,
        dialect,
        &mut params,
        &mut where_parts,
    )?;

    let mut sql = format!(
        "select {}\nfrom {} as {}",
        select.join(", "),
        cube.from_source()
            .ok_or_else(|| CompileError::NoSource(cube.name.clone()))?,
        quote(&cube.name)
    );
    for (from, to, join) in &plan.edges {
        let to_source = to
            .from_source()
            .ok_or_else(|| CompileError::NoSource(to.name.clone()))?;
        sql.push_str(&format!(
            "\nleft join {} as {} on {}",
            to_source,
            quote(&to.name),
            join_condition(&join.sql, from, model)
        ));
    }
    if !where_parts.is_empty() {
        sql.push_str(&format!("\nwhere {}", where_parts.join(" and ")));
    }
    sql.push_str(&format!("\ngroup by {}", group_by.join(", ")));
    sql.push_str(&format!(
        "\norder by {} desc, {} asc",
        quote("count"),
        quote("value")
    ));
    sql.push_str(&format!("\nlimit {}", limit.unwrap_or(50).min(500)));

    Ok(Compiled {
        sql,
        params,
        columns,
    })
}

/// Compile without a clock. Absolute date ranges work as always; a RELATIVE
/// range (`"last 30 days"`) is refused — resolution requires a clock, and the
/// compiler never reads system time. Runtime callers use [`compile_at`].
/// Enforce tenant scope for a planned query and append the scope predicates:
/// fail closed for EVERY cube in the join tree (a joined tenant cube
/// contributes its own predicate or the query is refused — the one place a
/// join could quietly become a cross-tenant read), then bind the scope
/// entries for every participating cube, sorted for deterministic SQL.
/// Shared by `compile_at` and `compile_values`.
fn apply_scope(
    plan: &JoinPlan,
    ctx: &SecurityContext,
    has_joins: bool,
    dialect: Dialect,
    params: &mut Vec<ScalarValue>,
    where_parts: &mut Vec<String>,
) -> Result<(), CompileError> {
    if !ctx.allow_unscoped {
        for cube in plan.cubes() {
            for (field, dim) in &cube.dimensions {
                if dim.tenant && !ctx.scope.contains_key(&format!("{}.{}", cube.name, field)) {
                    return Err(CompileError::MissingTenantScope {
                        cube: cube.name.clone(),
                        dimension: field.clone(),
                    });
                }
            }
        }
    }
    let participating: Vec<&Cube> = plan.cubes();
    let mut scope: Vec<(&String, &ScalarValue)> = ctx
        .scope
        .iter()
        .filter(|(member, _)| {
            split_member(member)
                .map(|(c, _)| participating.iter().any(|cube| cube.name == c))
                .unwrap_or(false)
        })
        .collect();
    scope.sort_by(|a, b| a.0.cmp(b.0));
    for (member, value) in scope {
        let (_, field) = split_member(member)?;
        let cube = plan.cube_for(member)?;
        let (expr, dt) = dimension_expr(cube, field, has_joins)?;
        params.push(value.clone());
        where_parts.push(format!(
            "{} = {}",
            expr,
            placeholder(params.len(), dt, dialect)
        ));
    }
    Ok(())
}

pub fn compile(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
) -> Result<Compiled, CompileError> {
    for td in &query.time_dimensions {
        if let Some(crate::query::DateRange::Relative(spec)) = &td.date_range {
            return Err(CompileError::RelativeDateNeedsClock(spec.clone()));
        }
    }
    compile_at(model, query, ctx, chrono::DateTime::UNIX_EPOCH)
}

/// Compile with an injected clock: relative date expressions resolve against
/// `now` in the query's `timezone`. Pure — same inputs, same SQL.
/// Check the constraints `compare` and `fill_gaps` share: a date range to
/// anchor on, aggregate mode, and the time dimension as the query's ONLY
/// grouping (no dimensions, one time dimension) — the v1 contract that keeps
/// bucket alignment and series generation honest. `fill_gaps` additionally
/// needs a granularity (there is no bucket size to fill without one).
fn validate_time_features(query: &Query) -> Result<(), CompileError> {
    let uses = |name: &str, extra: &str| -> CompileError {
        let msg = format!(
            "requires a date_range, aggregate mode, and the time dimension as the query's only \
             grouping (no dimensions, a single time dimension){extra}"
        );
        match name {
            "fill_gaps" => CompileError::BadFillGaps(msg),
            _ => CompileError::BadCompare(msg),
        }
    };
    for td in &query.time_dimensions {
        for (name, active) in [
            ("fill_gaps", td.fill_gaps),
            ("compare", td.compare.is_some()),
        ] {
            if !active {
                continue;
            }
            let solo = query.dimensions.is_empty()
                && query.time_dimensions.len() == 1
                && query.mode != QueryMode::Rows
                && td.date_range.is_some();
            if !solo {
                return Err(uses(name, ""));
            }
            if name == "fill_gaps" && td.granularity.is_none() {
                return Err(uses(name, ", plus a granularity to size the buckets"));
            }
        }
    }
    Ok(())
}

/// The gap-fill wrapping plan, captured while compiling the inner query.
struct FillSpec {
    alias: String,
    granularity: crate::query::Granularity,
    from_param: usize,
    to_param: usize,
}

pub fn compile_at(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Compiled, CompileError> {
    compile_at_for(model, query, ctx, now, Dialect::Postgres)
}

/// [`compile_at`] for a specific [`Dialect`]. Everything but the placeholder
/// and coercion syntax — join planning, scope injection, the fail-closed
/// tenant rule — is shared, so the dialects cannot drift apart on semantics.
pub fn compile_at_for(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
    now: chrono::DateTime<chrono::Utc>,
    dialect: Dialect,
) -> Result<Compiled, CompileError> {
    validate_time_features(query)?;
    let normalized = normalize_rows_mode(model, query)?;
    let query: &Query = normalized.as_ref();
    let is_rows = query.mode == QueryMode::Rows;
    let plan = plan_joins(model, query)?;
    let has_joins = plan.has_joins();
    let base = plan.base;
    let source = base
        .from_source()
        .ok_or_else(|| CompileError::NoSource(base.name.clone()))?;

    let mut select: Vec<String> = Vec::new();
    let mut group_by: Vec<String> = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut params: Vec<ScalarValue> = Vec::new();

    // Dimensions (group-by) — with the declared label, if any, projected
    // right after its dimension as `"{member}__label"`. The label is
    // presentation-only: sorting, filtering and grouping still act on the id.
    for member in &query.dimensions {
        let (_, field) = split_member(member)?;
        let cube = plan.cube_for(member)?;
        let (expr, _) = dimension_expr(cube, field, has_joins)?;
        select.push(format!("{} as {}", expr, quote(member)));
        if !is_rows {
            group_by.push(expr);
        }
        columns.push(Column {
            key: member.clone(),
            kind: "dimension".into(),
            drill_entity: cube
                .dimensions
                .get(field)
                .and_then(|d| d.drill.as_ref().map(|t| t.entity.clone())),
        });

        if let Some(label) = cube.dimensions.get(field).and_then(|d| d.label.clone()) {
            let (label_cube, label_field) = if label.contains('.') {
                let (_, label_field) = split_member(&label)?;
                (plan.cube_for(&label)?, label_field)
            } else {
                (cube, label.as_str())
            };
            let (label_expr, _) = dimension_expr(label_cube, label_field, has_joins)?;
            let alias = format!("{member}__label");
            select.push(format!("{} as {}", label_expr, quote(&alias)));
            if !is_rows {
                group_by.push(label_expr);
            }
            columns.push(Column::new(alias, "label"));
        }
    }

    // Time dimensions with a granularity are projected + grouped as buckets.
    // WITHOUT a granularity a time dimension is filter-only (its date_range
    // applies below, nothing is projected) — Cube's semantics, and what lets
    // a metric query carry a date window or comparison here.
    let filling = query.time_dimensions.iter().any(|td| td.fill_gaps);
    for td in &query.time_dimensions {
        let Some(g) = &td.granularity else { continue };
        let (_, field) = split_member(&td.dimension)?;
        let cube = plan.cube_for(&td.dimension)?;
        let (expr, _) = dimension_expr(cube, field, has_joins)?;
        let projected = as_text(&format!("date_trunc('{}', {})", g.as_pg(), expr), dialect);
        select.push(format!("{} as {}", projected, quote(&td.dimension)));
        if !is_rows {
            group_by.push(projected);
        }
        columns.push(Column::new(td.dimension.clone(), "time"));
    }

    // Measures (aggregations) — always on the base cube, by construction.
    for member in &query.measures {
        let (_, field) = split_member(member)?;
        let expr = measure_expr(base, field, has_joins, dialect)?;
        select.push(format!("{} as {}", expr, quote(member)));
        columns.push(Column::new(member.clone(), "measure"));
    }

    if select.is_empty() {
        return Err(CompileError::Empty);
    }

    // The row total rides the same statement as one window column — on a
    // grouped query it counts groups (what "1–25 of 312" means), and being
    // a window it is computed before LIMIT/OFFSET, so it reflects the whole
    // result set, not the page. The engine strips it into `total`. When
    // gap-filling, the total belongs on the OUTER query (it counts buckets).
    if query.include_total && !filling {
        select.push(format!("count(*) over () as {}", quote(TOTAL_ALIAS)));
        columns.push(Column::new(TOTAL_ALIAS, "total"));
    }

    // WHERE: user dimension filters, then time-dimension ranges, then
    // mandatory scope. Filters on MEASURES are collected for HAVING — they
    // compile after everything else so their bind placeholders number last.
    let mut where_parts: Vec<String> = Vec::new();
    let mut measure_filters: Vec<&Filter> = Vec::new();
    for f in &query.filters {
        let cube = plan.cube_for(&f.member)?;
        let (_, field) = split_member(&f.member)?;
        if cube.measures.contains_key(field) {
            if is_rows {
                return Err(CompileError::MeasureFilter(f.member.clone()));
            }
            measure_filters.push(f);
            continue;
        }
        where_parts.push(compile_filter(cube, has_joins, f, &mut params, dialect)?);
    }
    // Segments: named model-declared predicates, parenthesized into WHERE.
    // The segment's cube is already a participant (referenced_cubes), so its
    // joins and tenant scope apply like anything else.
    for seg in &query.segments {
        let (_, seg_name) = split_member(seg)?;
        let cube = plan.cube_for(seg)?;
        let segment = cube
            .segments
            .get(seg_name)
            .ok_or_else(|| CompileError::UnknownMember(seg.clone()))?;
        where_parts.push(format!("({})", join_condition(&segment.sql, cube, model)));
    }
    let tz =
        crate::dates::parse_tz(query.timezone.as_deref()).map_err(CompileError::BadTimezone)?;
    let mut fill: Option<FillSpec> = None;
    for td in &query.time_dimensions {
        if let Some(range) = &td.date_range {
            let (from, to) = crate::dates::resolve_date_range(range, now, tz)
                .map_err(CompileError::BadDateRange)?;
            let (_, field) = split_member(&td.dimension)?;
            let cube = plan.cube_for(&td.dimension)?;
            let (expr, dt) = dimension_expr(cube, field, has_joins)?;
            params.push(ScalarValue::String(from));
            where_parts.push(format!(
                "{} >= {}",
                expr,
                placeholder(params.len(), dt, dialect)
            ));
            params.push(ScalarValue::String(to));
            where_parts.push(format!(
                "{} < {}",
                expr,
                placeholder(params.len(), dt, dialect)
            ));
            if td.fill_gaps {
                fill = Some(FillSpec {
                    alias: td.dimension.clone(),
                    granularity: td
                        .granularity
                        .expect("validated: fill_gaps has granularity"),
                    from_param: params.len() - 1,
                    to_param: params.len(),
                });
            }
        }
    }
    apply_scope(
        &plan,
        ctx,
        has_joins,
        dialect,
        &mut params,
        &mut where_parts,
    )?;

    // HAVING: measure filters, compiled against the aggregate expression.
    // This is what makes "the worst N" buildable. Compiled last so the bind
    // placeholders follow the WHERE/scope parameters.
    let mut having_parts: Vec<String> = Vec::new();
    for f in measure_filters {
        let (_, field) = split_member(&f.member)?;
        let expr = measure_expr(base, field, has_joins, dialect)?;
        having_parts.push(compile_predicate(
            &expr,
            DimensionType::Number,
            f,
            &mut params,
            dialect,
        )?);
    }

    // ORDER BY by alias (any selected member).
    let mut order_parts: Vec<String> = Vec::new();
    for o in &query.order {
        order_parts.push(format!(
            "{} {}",
            quote(&o.member),
            if o.desc { "desc" } else { "asc" }
        ));
    }

    let mut sql = format!(
        "select {}\nfrom {} as {}",
        select.join(", "),
        source,
        quote(&base.name)
    );
    for (from, to, join) in &plan.edges {
        let to_source = to
            .from_source()
            .ok_or_else(|| CompileError::NoSource(to.name.clone()))?;
        sql.push_str(&format!(
            "\nleft join {} as {} on {}",
            to_source,
            quote(&to.name),
            join_condition(&join.sql, from, model)
        ));
    }
    if !where_parts.is_empty() {
        sql.push_str(&format!("\nwhere {}", where_parts.join(" and ")));
    }
    if !group_by.is_empty() {
        sql.push_str(&format!("\ngroup by {}", group_by.join(", ")));
    }
    if !having_parts.is_empty() {
        sql.push_str(&format!("\nhaving {}", having_parts.join(" and ")));
    }

    // Gap filling: wrap the aggregate in a generate_series LEFT JOIN over the
    // window's buckets, so an empty bucket appears as 0 instead of vanishing.
    // The series reuses the window's own bind parameters; a missing bucket's
    // measures coalesce to 0 — the point of the feature.
    //
    // The series scaffold is Postgres-specific, so on any other dialect the
    // feature is refused loudly rather than compiled into SQL that fails at
    // runtime — the same trade as FanOut: a missing capability beats a wrong
    // or broken answer.
    if fill.is_some() && dialect != Dialect::Postgres {
        return Err(CompileError::BadFillGaps(format!(
            "not yet supported on the {dialect:?} dialect — its generate_series scaffold is \
             postgres-specific"
        )));
    }
    if let Some(fill) = &fill {
        let step = fill.granularity.series_step();
        let trunc = fill.granularity.as_pg();
        let alias = quote(&fill.alias);
        let mut outer: Vec<String> = vec![format!("gs.bucket::text as {alias}")];
        for member in &query.measures {
            let m = quote(member);
            outer.push(format!("coalesce(q.{m}, 0) as {m}"));
        }
        if query.include_total {
            outer.push(format!("count(*) over () as {}", quote(TOTAL_ALIAS)));
            columns.push(Column::new(TOTAL_ALIAS, "total"));
        }
        sql = format!(
            "select {}\nfrom generate_series(date_trunc('{trunc}', ${}::timestamptz), ${}::timestamptz - interval '{step}', interval '{step}') as gs(bucket)\nleft join (\n{sql}\n) as q on q.{alias} = gs.bucket::text",
            outer.join(", "),
            fill.from_param,
            fill.to_param,
        );
    }

    if !order_parts.is_empty() {
        sql.push_str(&format!("\norder by {}", order_parts.join(", ")));
    } else if fill.is_some() {
        sql.push_str("\norder by gs.bucket");
    }
    if let Some(limit) = query.limit {
        sql.push_str(&format!("\nlimit {limit}"));
    }
    if let Some(offset) = query.offset {
        sql.push_str(&format!("\noffset {offset}"));
    }

    Ok(Compiled {
        sql,
        params,
        columns,
    })
}

fn compile_filter(
    cube: &Cube,
    has_joins: bool,
    f: &Filter,
    params: &mut Vec<ScalarValue>,
    dialect: Dialect,
) -> Result<String, CompileError> {
    let (_, field) = split_member(&f.member)?;
    let (expr, dim_type) = dimension_expr(cube, field, has_joins)?;
    compile_predicate(&expr, dim_type, f, params, dialect)
}

/// Compile one filter operator against an already-resolved SQL expression —
/// shared by WHERE (dimension exprs) and HAVING (aggregate exprs).
fn compile_predicate(
    expr: &str,
    dim_type: DimensionType,
    f: &Filter,
    params: &mut Vec<ScalarValue>,
    dialect: Dialect,
) -> Result<String, CompileError> {
    let one = |params: &mut Vec<ScalarValue>| -> Result<usize, CompileError> {
        let v = f
            .values
            .first()
            .cloned()
            .ok_or_else(|| CompileError::NeedsOneValue(f.member.clone()))?;
        params.push(v);
        Ok(params.len())
    };
    let ph = |idx| placeholder(idx, dim_type, dialect);

    Ok(match f.operator {
        FilterOperator::Equals => format!("{} = {}", expr, ph(one(params)?)),
        FilterOperator::NotEquals => format!("{} <> {}", expr, ph(one(params)?)),
        FilterOperator::Gt => format!("{} > {}", expr, ph(one(params)?)),
        FilterOperator::Gte => format!("{} >= {}", expr, ph(one(params)?)),
        FilterOperator::Lt => format!("{} < {}", expr, ph(one(params)?)),
        FilterOperator::Lte => format!("{} <= {}", expr, ph(one(params)?)),
        FilterOperator::Set => format!("{} is not null", expr),
        FilterOperator::NotSet => format!("{} is null", expr),
        FilterOperator::Contains => {
            let v = match f.values.first() {
                Some(ScalarValue::String(s)) => s.clone(),
                Some(other) => scalar_to_string(other),
                None => return Err(CompileError::NeedsOneValue(f.member.clone())),
            };
            params.push(ScalarValue::String(format!("%{v}%")));
            // ilike needs text; cast the column so it works on non-text
            // columns. Both dialects spell the operator `ilike`.
            format!(
                "{} ilike {}",
                as_text(expr, dialect),
                placeholder(params.len(), DimensionType::String, dialect)
            )
        }
        FilterOperator::In | FilterOperator::NotIn => {
            if f.values.is_empty() {
                return Err(CompileError::NeedsOneValue(f.member.clone()));
            }
            let mut placeholders = Vec::new();
            for v in &f.values {
                params.push(v.clone());
                placeholders.push(ph(params.len()));
            }
            let op = if matches!(f.operator, FilterOperator::In) {
                "in"
            } else {
                "not in"
            };
            format!("{} {} ({})", expr, op, placeholders.join(", "))
        }
    })
}

fn scalar_to_string(v: &ScalarValue) -> String {
    match v {
        ScalarValue::String(s) => s.clone(),
        ScalarValue::Int(i) => i.to_string(),
        ScalarValue::Float(f) => f.to_string(),
        ScalarValue::Bool(b) => b.to_string(),
        ScalarValue::Null => String::new(),
    }
}
