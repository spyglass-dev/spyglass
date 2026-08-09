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
use crate::query::{Column, Filter, FilterOperator, Query, ScalarValue};
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
    #[error("filter on measure '{0}' is not supported")]
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
}

/// A compiled, parameterized statement ready for an engine to execute.
#[derive(Debug, Clone)]
pub struct Compiled {
    pub sql: String,
    pub params: Vec<ScalarValue>,
    pub columns: Vec<Column>,
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
        return Ok(JoinPlan { base, edges: Vec::new() });
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
                return Err(CompileError::FanOut { from: from.clone(), to: target.clone() });
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
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
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

fn measure_expr(cube: &Cube, field: &str, has_joins: bool) -> Result<String, CompileError> {
    let m = cube
        .measures
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(format!("{}.{}", cube.name, field)))?;
    let sql = m
        .sql
        .as_ref()
        .map(|s| qualify_expr(s, cube, has_joins));
    Ok(match m.measure_type {
        MeasureType::Count => "count(*)".to_string(),
        MeasureType::CountDistinct => format!(
            "count(distinct {})",
            sql.unwrap_or_else(|| "*".to_string())
        ),
        // Cast numeric aggregates to float8 so engines get a predictable type.
        MeasureType::Sum => format!("sum({})::float8", req_sql(sql, field)?),
        MeasureType::Avg => format!("avg({})::float8", req_sql(sql, field)?),
        MeasureType::Min => format!("min({})::float8", req_sql(sql, field)?),
        MeasureType::Max => format!("max({})::float8", req_sql(sql, field)?),
        MeasureType::Number => format!("({})::float8", req_sql(sql, field)?),
    })
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

/// A bind placeholder (`$n`) with the type cast for `dim_type`.
fn placeholder(idx: usize, dim_type: DimensionType) -> String {
    format!("${}{}", idx, cast_for(dim_type))
}

pub fn compile(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
) -> Result<Compiled, CompileError> {
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
        group_by.push(expr);
        columns.push(Column { key: member.clone(), kind: "dimension".into() });

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
            group_by.push(label_expr);
            columns.push(Column { key: alias, kind: "label".into() });
        }
    }

    // Time dimensions (optionally truncated), also group-by.
    for td in &query.time_dimensions {
        let (_, field) = split_member(&td.dimension)?;
        let cube = plan.cube_for(&td.dimension)?;
        let (expr, _) = dimension_expr(cube, field, has_joins)?;
        let projected = match &td.granularity {
            Some(g) => format!("date_trunc('{}', {})::text", g.as_pg(), expr),
            None => format!("({})::text", expr),
        };
        select.push(format!("{} as {}", projected, quote(&td.dimension)));
        group_by.push(projected);
        columns.push(Column { key: td.dimension.clone(), kind: "time".into() });
    }

    // Measures (aggregations) — always on the base cube, by construction.
    for member in &query.measures {
        let (_, field) = split_member(member)?;
        let expr = measure_expr(base, field, has_joins)?;
        select.push(format!("{} as {}", expr, quote(member)));
        columns.push(Column { key: member.clone(), kind: "measure".into() });
    }

    if select.is_empty() {
        return Err(CompileError::Empty);
    }

    // WHERE: user filters, then time-dimension ranges, then mandatory scope.
    let mut where_parts: Vec<String> = Vec::new();
    for f in &query.filters {
        let cube = plan.cube_for(&f.member)?;
        where_parts.push(compile_filter(cube, has_joins, f, &mut params)?);
    }
    for td in &query.time_dimensions {
        if let Some([from, to]) = &td.date_range {
            let (_, field) = split_member(&td.dimension)?;
            let cube = plan.cube_for(&td.dimension)?;
            let (expr, dt) = dimension_expr(cube, field, has_joins)?;
            params.push(ScalarValue::String(from.clone()));
            where_parts.push(format!("{} >= {}", expr, placeholder(params.len(), dt)));
            params.push(ScalarValue::String(to.clone()));
            where_parts.push(format!("{} < {}", expr, placeholder(params.len(), dt)));
        }
    }
    // Fail closed for EVERY cube in the join tree, not just the base: a
    // joined tenant cube contributes its own scope predicate or the query is
    // refused. This is the one place a join could quietly become a
    // cross-tenant read. Admin/offline callers opt out explicitly.
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

    // Mandatory scope filters — the entries for every participating cube (the
    // scope is a model-wide map keyed by `Cube.member`). Sorted for
    // deterministic SQL.
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
        where_parts.push(format!("{} = {}", expr, placeholder(params.len(), dt)));
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
    if !order_parts.is_empty() {
        sql.push_str(&format!("\norder by {}", order_parts.join(", ")));
    }
    if let Some(limit) = query.limit {
        sql.push_str(&format!("\nlimit {limit}"));
    }

    Ok(Compiled { sql, params, columns })
}

fn compile_filter(
    cube: &Cube,
    has_joins: bool,
    f: &Filter,
    params: &mut Vec<ScalarValue>,
) -> Result<String, CompileError> {
    let (_, field) = split_member(&f.member)?;
    if cube.measures.contains_key(field) {
        return Err(CompileError::MeasureFilter(f.member.clone()));
    }
    let (expr, dim_type) = dimension_expr(cube, field, has_joins)?;

    let one = |params: &mut Vec<ScalarValue>| -> Result<usize, CompileError> {
        let v = f
            .values
            .first()
            .cloned()
            .ok_or_else(|| CompileError::NeedsOneValue(f.member.clone()))?;
        params.push(v);
        Ok(params.len())
    };
    let ph = |idx| placeholder(idx, dim_type);

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
            // ilike needs text; cast the column so it works on non-text columns.
            format!("{}::text ilike ${}", expr, params.len())
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
            let op = if matches!(f.operator, FilterOperator::In) { "in" } else { "not in" };
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
