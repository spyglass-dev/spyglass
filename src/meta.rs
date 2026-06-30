//! Model metadata — the discoverable catalog a UI/agent needs to build queries.
//!
//! The internal [`Model`](crate::model::Model) carries SQL (`sql`, `sql_table`)
//! that callers must never see. [`Model::metadata`] projects it into a safe,
//! UI-facing shape: cubes with their measures and dimensions keyed by
//! `Cube.member`, with types/titles/format and the tenant flag — and no SQL.

use crate::model::{DimensionType, MeasureType, Model};
use serde::Serialize;

/// The whole model's public catalog.
#[derive(Debug, Clone, Serialize)]
pub struct ModelMeta {
    pub cubes: Vec<CubeMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CubeMeta {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub measures: Vec<MeasureMeta>,
    pub dimensions: Vec<DimensionMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeasureMeta {
    /// Local key, e.g. `revenue`.
    pub name: String,
    /// Fully-qualified member, e.g. `Orders.revenue` — what a query references.
    pub member: String,
    #[serde(rename = "type")]
    pub measure_type: MeasureType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DimensionMeta {
    pub name: String,
    pub member: String,
    #[serde(rename = "type")]
    pub dimension_type: DimensionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// True for the tenant/scope column (e.g. `workspace_id`).
    pub tenant: bool,
}

impl Model {
    /// Project the model into its UI-facing catalog (no SQL leaks). Cubes,
    /// measures, and dimensions come out in deterministic (sorted) order.
    pub fn metadata(&self) -> ModelMeta {
        let cubes = self
            .cubes
            .values()
            .map(|cube| {
                let measures = cube
                    .measures
                    .iter()
                    .map(|(name, m)| MeasureMeta {
                        name: name.clone(),
                        member: format!("{}.{}", cube.name, name),
                        measure_type: m.measure_type,
                        title: m.title.clone(),
                        format: m.format.clone(),
                    })
                    .collect();
                let dimensions = cube
                    .dimensions
                    .iter()
                    .map(|(name, d)| DimensionMeta {
                        name: name.clone(),
                        member: format!("{}.{}", cube.name, name),
                        dimension_type: d.dimension_type,
                        title: d.title.clone(),
                        tenant: d.tenant,
                    })
                    .collect();
                CubeMeta {
                    name: cube.name.clone(),
                    title: cube.title.clone(),
                    description: cube.description.clone(),
                    measures,
                    dimensions,
                }
            })
            .collect();
        ModelMeta { cubes }
    }
}
