//! Security context — multi-tenant scoping applied to every query.
//!
//! The host (e.g. Zippy) builds a [`SecurityContext`] from the authenticated
//! request and the engine injects its `scope` as mandatory equals-filters at
//! compile time. This is the "never expose raw tables, always scope to the
//! tenant" guarantee: callers/agents pick measures + dimensions, but cannot
//! escape the workspace/student scope the host pins here.
//!
//! Conceptually the analog of Cube's `securityContext` + `queryRewrite`.

use crate::query::ScalarValue;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default)]
pub struct SecurityContext {
    /// Mandatory equals-filters keyed by `Cube.dimension` member. Appended to
    /// every query; the caller cannot override or remove them.
    pub scope: BTreeMap<String, ScalarValue>,
}

impl SecurityContext {
    /// Convenience: scope to a workspace by a cube's tenant dimension member.
    pub fn with_scope(mut self, member: impl Into<String>, value: ScalarValue) -> Self {
        self.scope.insert(member.into(), value);
        self
    }
}
