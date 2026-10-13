//! The spyglass compiler, compiled to WASM.
//!
//! The browser holds a [`Spyglass`] built from cube YAML. For each query it
//! asks for a plan (the SQL for the current window and, for `compare`, the
//! previous one), executes that SQL on whatever engine it has — DuckDB-WASM in
//! the demo — and hands the rows back to [`Spyglass::assemble`]. Plan and
//! assembly are the same functions the Postgres engine runs, so a report
//! behaves identically against a server and against a dataset in the browser.

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;
use spyglass::engine::{assemble_run, plan_run, JsonRow, RunPlan};
use spyglass::{Dialect, Model, Query, ScalarValue, SecurityContext};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Spyglass {
    model: Model,
    plans: RefCell<HashMap<u32, RunPlan>>,
    next_id: RefCell<u32>,
}

#[derive(Serialize)]
struct Statement<'a> {
    sql: &'a str,
    params: &'a [ScalarValue],
}

#[derive(Serialize)]
struct PlanOut<'a> {
    id: u32,
    main: Statement<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prev: Option<Statement<'a>>,
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn context(scope_json: Option<String>) -> Result<SecurityContext, JsError> {
    let scope: HashMap<String, ScalarValue> = match scope_json {
        Some(s) if !s.is_empty() => serde_json::from_str(&s).map_err(js_err)?,
        _ => HashMap::new(),
    };
    let mut ctx = SecurityContext::default();
    for (member, value) in scope {
        ctx = ctx.with_scope(member, value);
    }
    Ok(ctx)
}

fn instant(now_ms: f64) -> Result<chrono::DateTime<chrono::Utc>, JsError> {
    chrono::DateTime::from_timestamp_millis(now_ms as i64)
        .ok_or_else(|| JsError::new("now_ms is out of range"))
}

#[wasm_bindgen]
impl Spyglass {
    /// Load a model from cube YAML (the same files the server loads).
    #[wasm_bindgen(constructor)]
    pub fn new(cubes_yaml: &str) -> Result<Spyglass, JsError> {
        let model = spyglass::loader::parse_str(cubes_yaml, "cubes.yml").map_err(js_err)?;
        Ok(Spyglass {
            model,
            plans: RefCell::new(HashMap::new()),
            next_id: RefCell::new(0),
        })
    }

    /// The `/meta` payload: cubes, members, titles, formats, drill hints.
    pub fn meta(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.model.metadata()).map_err(js_err)
    }

    /// Compile a query. Returns `{id, main: {sql, params}, prev?}`; execute the
    /// statements and pass the rows to [`Spyglass::assemble`] with `id`.
    pub fn plan(
        &self,
        query_json: &str,
        scope_json: Option<String>,
        now_ms: f64,
        max_rows: Option<u32>,
    ) -> Result<String, JsError> {
        let query: Query = serde_json::from_str(query_json).map_err(js_err)?;
        let ctx = context(scope_json)?;
        let plan = plan_run(
            &self.model,
            &query,
            &ctx,
            instant(now_ms)?,
            Dialect::Postgres,
            max_rows,
        )
        .map_err(js_err)?;
        let id = {
            let mut next = self.next_id.borrow_mut();
            *next = next.wrapping_add(1);
            *next
        };
        let out = serde_json::to_string(&PlanOut {
            id,
            main: Statement {
                sql: &plan.main.sql,
                params: &plan.main.params,
            },
            prev: plan.prev.as_ref().map(|p| Statement {
                sql: &p.compiled.sql,
                params: &p.compiled.params,
            }),
        })
        .map_err(js_err)?;
        self.plans.borrow_mut().insert(id, plan);
        Ok(out)
    }

    /// Turn fetched rows into a `QueryResult`. Consumes the plan.
    pub fn assemble(
        &self,
        id: u32,
        rows_json: &str,
        prev_rows_json: Option<String>,
    ) -> Result<String, JsError> {
        let plan = self
            .plans
            .borrow_mut()
            .remove(&id)
            .ok_or_else(|| JsError::new("unknown plan id"))?;
        let rows: Vec<JsonRow> = serde_json::from_str(rows_json).map_err(js_err)?;
        let prev_rows: Option<Vec<JsonRow>> = match prev_rows_json {
            Some(s) => Some(serde_json::from_str(&s).map_err(js_err)?),
            None => None,
        };
        serde_json::to_string(&assemble_run(&plan, rows, prev_rows)).map_err(js_err)
    }

    /// Drop a plan whose execution failed.
    pub fn discard(&self, id: u32) {
        self.plans.borrow_mut().remove(&id);
    }

    /// The `/values` statement for a `filterable` dimension.
    pub fn values(
        &self,
        member: &str,
        search: Option<String>,
        limit: Option<u32>,
        scope_json: Option<String>,
    ) -> Result<String, JsError> {
        let ctx = context(scope_json)?;
        let compiled = spyglass::compiler::compile_values_for(
            &self.model,
            member,
            search.as_deref(),
            limit,
            &ctx,
            Dialect::Postgres,
        )
        .map_err(js_err)?;
        serde_json::to_string(&Statement {
            sql: &compiled.sql,
            params: &compiled.params,
        })
        .map_err(js_err)
    }
}
