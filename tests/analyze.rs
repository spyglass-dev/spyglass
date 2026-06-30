//! Pure analyzer helpers (DB-free): column classification + identifier quoting.

use spyglass::analyze::{classify, quote_ident, ColumnClass};

#[test]
fn classifies_column_types() {
    assert_eq!(classify("text"), ColumnClass::Categorical);
    assert_eq!(classify("boolean"), ColumnClass::Categorical);
    assert_eq!(classify("integer"), ColumnClass::Numeric);
    assert_eq!(classify("double precision"), ColumnClass::Numeric);
    assert_eq!(classify("timestamp with time zone"), ColumnClass::Temporal);
    assert_eq!(classify("date"), ColumnClass::Temporal);
    assert_eq!(classify("jsonb"), ColumnClass::Other);
}

#[test]
fn quotes_identifiers_safely() {
    assert_eq!(quote_ident("status"), "\"status\"");
    assert_eq!(quote_ident("weird\"name"), "\"weird\"\"name\"");
}
