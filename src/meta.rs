//! Model metadata — the discoverable catalog a UI/agent needs to build queries.
//!
//! The internal [`Model`](crate::model::Model) carries SQL (`sql`, `sql_table`)
//! that callers must never see. [`Model::metadata`] projects it into a safe,
//! UI-facing shape: cubes with their measures and dimensions keyed by
//! `Cube.member`, with types/titles/format and the tenant flag — and no SQL.

use crate::model::{DimensionType, JoinRelationship, MeasureType, Model};
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
    /// Join edges this cube declares — target + relationship only, no SQL.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub joins: Vec<JoinMeta>,
    /// The cube's row-mode allowlist (and PII boundary). Empty = no row mode.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub drill_members: Vec<String>,
}

/// A join edge in the public catalog: where it goes and whether a query may
/// traverse it — never the join SQL.
#[derive(Debug, Clone, Serialize)]
pub struct JoinMeta {
    pub target: String,
    pub relationship: JoinRelationship,
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
    /// Measure-level narrowing of the cube's `drill_members`, if declared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drill_members: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub featured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub filterable: bool,
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
    /// Member whose value is displayed for this dimension (auto-projected as
    /// `"{member}__label"` when the dimension is selected).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The entity a click on this dimension's value identifies (drives the
    /// UI's `DrillEvent.entity`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drill_entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub featured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub filterable: bool,
}

impl Model {
    /// Project the model into its UI-facing catalog (no SQL leaks). Cubes,
    /// measures, and dimensions come out in deterministic (sorted) order.
    /// `hidden` members are omitted entirely — hidden curates discovery
    /// (the member stays queryable by name); it is not a security boundary.
    pub fn metadata(&self) -> ModelMeta {
        let cubes = self
            .cubes
            .values()
            .map(|cube| {
                let measures = cube
                    .measures
                    .iter()
                    .filter(|(_, m)| !m.hidden)
                    .map(|(name, m)| MeasureMeta {
                        name: name.clone(),
                        member: format!("{}.{}", cube.name, name),
                        measure_type: m.measure_type,
                        title: m.title.clone(),
                        format: m.format.clone(),
                        drill_members: m.drill_members.clone(),
                        description: m.description.clone(),
                        featured: m.featured,
                        unit: m.unit.clone(),
                        filterable: m.filterable,
                    })
                    .collect();
                let dimensions = cube
                    .dimensions
                    .iter()
                    .filter(|(_, d)| !d.hidden)
                    .map(|(name, d)| DimensionMeta {
                        name: name.clone(),
                        member: format!("{}.{}", cube.name, name),
                        dimension_type: d.dimension_type,
                        title: d.title.clone(),
                        tenant: d.tenant,
                        label: d.label.clone(),
                        drill_entity: d.drill.as_ref().map(|t| t.entity.clone()),
                        description: d.description.clone(),
                        featured: d.featured,
                        unit: d.unit.clone(),
                        filterable: d.filterable,
                    })
                    .collect();
                let joins = cube
                    .joins
                    .iter()
                    .map(|(target, j)| JoinMeta {
                        target: target.clone(),
                        relationship: j.relationship,
                    })
                    .collect();
                CubeMeta {
                    name: cube.name.clone(),
                    title: cube.title.clone(),
                    description: cube.description.clone(),
                    measures,
                    dimensions,
                    joins,
                    drill_members: cube.drill_members.clone(),
                }
            })
            .collect();
        ModelMeta { cubes }
    }
}
