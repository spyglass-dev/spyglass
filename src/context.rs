//! Security context — multi-tenant scoping applied to every query.
//!
//! The host (e.g. Zippy) builds a [`SecurityContext`] from the authenticated
//! request and the engine injects its `scope` as mandatory equals-filters at
//! compile time. This is the "never expose raw tables, always scope to the
//! tenant" guarantee: callers/agents pick measures + dimensions, but cannot
//! escape the workspace/student scope the host pins here.
//!
//! **Fail closed:** the compiler *refuses* to compile a query against a cube
//! that declares a tenant dimension unless a scope value for that dimension is
//! present. A caller who forgets (or is tricked into omitting) the scope gets
//! an error, never an unscoped full-table read across every tenant. The only
//! way to run cross-tenant is to set [`SecurityContext::allow_unscoped`] — an
//! explicit, auditable opt-in for admin/offline callers.
//!
//! Conceptually the analog of Cube's `securityContext` + `queryRewrite`.

use crate::query::ScalarValue;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default)]
pub struct SecurityContext {
    /// Mandatory equals-filters keyed by `Cube.dimension` member. Appended to
    /// every query; the caller cannot override or remove them.
    pub scope: BTreeMap<String, ScalarValue>,
    /// Opt out of the fail-closed tenant-scope requirement. `false` (the
    /// default) means any cube with a `tenant` dimension MUST be scoped or the
    /// compile fails. Set `true` only for trusted admin/offline paths that
    /// deliberately read across tenants — never on a runtime request path.
    pub allow_unscoped: bool,
}

impl SecurityContext {
    /// Convenience: scope to a workspace by a cube's tenant dimension member.
    pub fn with_scope(mut self, member: impl Into<String>, value: ScalarValue) -> Self {
        self.scope.insert(member.into(), value);
        self
    }

    /// Escape hatch for trusted admin/offline callers that intentionally read
    /// across tenants. Disables the fail-closed tenant-scope requirement.
    pub fn allow_unscoped(mut self) -> Self {
        self.allow_unscoped = true;
        self
    }
}
