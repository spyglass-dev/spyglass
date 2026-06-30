//! The query compiler — turns a [`Query`] + [`Model`] + [`SecurityContext`]
//! into a parameterized SQL statement. Pure (no I/O), so it's fully
//! unit-tested without a database. Engines execute the result.
//!
//! MVP scope: a single cube per query (no cross-cube joins yet). Values are
//! always bound as `$n` parameters — never string-interpolated — so the
//! compiled SQL is injection-safe by construction.

use crate::context::SecurityContext;
use crate::model::{Cube, DimensionType, MeasureType, Model};
use crate::query::{Column, Filter, FilterOperator, Query, ScalarValue};

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("query references no members")]
    Empty,
    #[error("query spans multiple cubes ({0:?}); only single-cube queries are supported")]
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

/// Resolve which cube a query targets — every member must share it.
fn resolve_cube_name(query: &Query, ctx: &SecurityContext) -> Result<String, CompileError> {
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
    for m in ctx.scope.keys() {
        push(m)?;
    }
    match names.len() {
        0 => Err(CompileError::Empty),
        1 => Ok(names.remove(0)),
        _ => Err(CompileError::MultipleCubes(names)),
    }
}

fn dimension_expr(cube: &Cube, field: &str) -> Result<(String, DimensionType), CompileError> {
    let d = cube
        .dimensions
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(format!("{}.{}", cube.name, field)))?;
    let sql = d.sql.clone().unwrap_or_else(|| field.to_string());
    Ok((sql, d.dimension_type))
}

fn measure_expr(cube: &Cube, field: &str) -> Result<String, CompileError> {
    let m = cube
        .measures
        .get(field)
        .ok_or_else(|| CompileError::UnknownMember(format!("{}.{}", cube.name, field)))?;
    let sql = m.sql.clone();
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

pub fn compile(
    model: &Model,
    query: &Query,
    ctx: &SecurityContext,
) -> Result<Compiled, CompileError> {
    let cube_name = resolve_cube_name(query, ctx)?;
    let cube = model
        .cube(&cube_name)
        .ok_or_else(|| CompileError::UnknownCube(cube_name.clone()))?;
    let source = cube
        .from_source()
        .ok_or_else(|| CompileError::NoSource(cube_name.clone()))?;

    let mut select: Vec<String> = Vec::new();
    let mut group_by: Vec<String> = Vec::new();
    let mut columns: Vec<Column> = Vec::new();
    let mut params: Vec<ScalarValue> = Vec::new();

    // Dimensions (group-by).
    for member in &query.dimensions {
        let (_, field) = split_member(member)?;
        let (expr, _) = dimension_expr(cube, field)?;
        select.push(format!("{} as {}", expr, quote(member)));
        group_by.push(expr);
        columns.push(Column { key: member.clone(), kind: "dimension".into() });
    }

    // Time dimensions (optionally truncated), also group-by.
    for td in &query.time_dimensions {
        let (_, field) = split_member(&td.dimension)?;
        let (expr, _) = dimension_expr(cube, field)?;
        let projected = match &td.granularity {
            Some(g) => format!("date_trunc('{}', {})::text", g.as_pg(), expr),
            None => format!("({})::text", expr),
        };
        select.push(format!("{} as {}", projected, quote(&td.dimension)));
        group_by.push(projected);
        columns.push(Column { key: td.dimension.clone(), kind: "time".into() });
    }

    // Measures (aggregations).
    for member in &query.measures {
        let (_, field) = split_member(member)?;
        let expr = measure_expr(cube, field)?;
        select.push(format!("{} as {}", expr, quote(member)));
        columns.push(Column { key: member.clone(), kind: "measure".into() });
    }

    if select.is_empty() {
        return Err(CompileError::Empty);
    }

    // WHERE: user filters, then time-dimension ranges, then mandatory scope.
    let mut where_parts: Vec<String> = Vec::new();
    for f in &query.filters {
        where_parts.push(compile_filter(cube, f, &mut params)?);
    }
    for td in &query.time_dimensions {
        if let Some([from, to]) = &td.date_range {
            let (_, field) = split_member(&td.dimension)?;
            let (expr, _) = dimension_expr(cube, field)?;
            params.push(ScalarValue::String(from.clone()));
            where_parts.push(format!("{} >= ${}", expr, params.len()));
            params.push(ScalarValue::String(to.clone()));
            where_parts.push(format!("{} < ${}", expr, params.len()));
        }
    }
    // Mandatory scope filters — sorted for deterministic SQL.
    let mut scope: Vec<(&String, &ScalarValue)> = ctx.scope.iter().collect();
    scope.sort_by(|a, b| a.0.cmp(b.0));
    for (member, value) in scope {
        let (_, field) = split_member(member)?;
        let (expr, _) = dimension_expr(cube, field)?;
        params.push(value.clone());
        where_parts.push(format!("{} = ${}", expr, params.len()));
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
        quote(&cube.name)
    );
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
    f: &Filter,
    params: &mut Vec<ScalarValue>,
) -> Result<String, CompileError> {
    let (_, field) = split_member(&f.member)?;
    if cube.measures.contains_key(field) {
        return Err(CompileError::MeasureFilter(f.member.clone()));
    }
    let (expr, _) = dimension_expr(cube, field)?;

    let one = |params: &mut Vec<ScalarValue>| -> Result<usize, CompileError> {
        let v = f
            .values
            .first()
            .cloned()
            .ok_or_else(|| CompileError::NeedsOneValue(f.member.clone()))?;
        params.push(v);
        Ok(params.len())
    };

    Ok(match f.operator {
        FilterOperator::Equals => format!("{} = ${}", expr, one(params)?),
        FilterOperator::NotEquals => format!("{} <> ${}", expr, one(params)?),
        FilterOperator::Gt => format!("{} > ${}", expr, one(params)?),
        FilterOperator::Gte => format!("{} >= ${}", expr, one(params)?),
        FilterOperator::Lt => format!("{} < ${}", expr, one(params)?),
        FilterOperator::Lte => format!("{} <= ${}", expr, one(params)?),
        FilterOperator::Set => format!("{} is not null", expr),
        FilterOperator::NotSet => format!("{} is null", expr),
        FilterOperator::Contains => {
            let v = match f.values.first() {
                Some(ScalarValue::String(s)) => s.clone(),
                Some(other) => scalar_to_string(other),
                None => return Err(CompileError::NeedsOneValue(f.member.clone())),
            };
            params.push(ScalarValue::String(format!("%{v}%")));
            format!("{} ilike ${}", expr, params.len())
        }
        FilterOperator::In | FilterOperator::NotIn => {
            if f.values.is_empty() {
                return Err(CompileError::NeedsOneValue(f.member.clone()));
            }
            let mut placeholders = Vec::new();
            for v in &f.values {
                params.push(v.clone());
                placeholders.push(format!("${}", params.len()));
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
