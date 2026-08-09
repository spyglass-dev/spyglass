//! Load Cube-format definitions from disk.
//!
//! A file may contain either a whole [`Model`] (`cubes:` map) or a single
//! [`Cube`] (`name:` at the top level). [`load_dir`] reads every
//! `*.yml` / `*.yaml` / `*.json` in a directory and merges them — this is what
//! the `spyglass-server` binary uses to read the working directory.

use crate::model::{Cube, Model};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("parse error in {path}: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_yaml::Error,
    },
    #[error("invalid model in {dir}:\n  {}", problems.join("\n  "))]
    Invalid { dir: String, problems: Vec<String> },
}

/// Parse one definition file's contents into a [`Model`] (accepts a full model
/// or a single cube). YAML parsing also accepts JSON.
pub fn parse_str(contents: &str, path_for_errors: &str) -> Result<Model, LoadError> {
    let mut value: serde_yaml::Value =
        serde_yaml::from_str(contents).map_err(|source| LoadError::Parse {
            path: path_for_errors.to_string(),
            source,
        })?;
    // Accept the canonical Cube list-form too: `cubes:` / `dimensions:` /
    // `measures:` as sequences of `{ name, … }`. Normalize them to the
    // name-keyed maps the structs expect.
    normalize_list_form(&mut value);
    let is_single_cube = value.get("name").is_some() && value.get("cubes").is_none();
    if is_single_cube {
        let cube: Cube = serde_yaml::from_value(value).map_err(|source| LoadError::Parse {
            path: path_for_errors.to_string(),
            source,
        })?;
        let mut model = Model::default();
        model.cubes.insert(cube.name.clone(), cube);
        Ok(model)
    } else {
        let mut model: Model = serde_yaml::from_value(value).map_err(|source| LoadError::Parse {
            path: path_for_errors.to_string(),
            source,
        })?;
        // Backfill each cube's `name` from its map key (definitions under a
        // `cubes:` map don't repeat the name). An explicit `name:` inside a
        // cube still wins.
        for (key, cube) in model.cubes.iter_mut() {
            if cube.name.is_empty() {
                cube.name = key.clone();
            }
        }
        Ok(model)
    }
}

/// Turn a `{ name, … }` **sequence** into a mapping keyed by each item's
/// `name`. No-op if the value isn't a sequence. Items without a string `name`
/// are dropped (they can't be addressed as `Cube.member` anyway).
fn seq_to_map_by_name(value: &mut serde_yaml::Value) {
    if let serde_yaml::Value::Sequence(seq) = value {
        let mut map = serde_yaml::Mapping::new();
        for item in std::mem::take(seq) {
            if let Some(serde_yaml::Value::String(name)) = item.get("name").cloned() {
                map.insert(serde_yaml::Value::String(name), item);
            }
        }
        *value = serde_yaml::Value::Mapping(map);
    }
}

/// Normalize a cube's `dimensions`/`measures` from list-form to map-form.
fn normalize_cube(cube: &mut serde_yaml::Value) {
    for field in ["dimensions", "measures"] {
        if let Some(v) = cube.get_mut(field) {
            seq_to_map_by_name(v);
        }
    }
}

/// Accept the canonical Cube list-form (`cubes`/`dimensions`/`measures` as
/// sequences of `{ name, … }`) by normalizing to the name-keyed map-form the
/// model structs deserialize from. Handles both the `cubes:` model form and the
/// single-cube (top-level `name:`) form.
fn normalize_list_form(value: &mut serde_yaml::Value) {
    if let Some(cubes) = value.get_mut("cubes") {
        seq_to_map_by_name(cubes);
        if let serde_yaml::Value::Mapping(map) = cubes {
            for (_k, cube) in map.iter_mut() {
                normalize_cube(cube);
            }
        }
    } else if value.get("name").is_some() {
        normalize_cube(value);
    }
}

/// Load + merge every definition file in `dir`.
pub fn load_dir(dir: impl AsRef<Path>) -> Result<Model, LoadError> {
    let dir = dir.as_ref();
    let mut model = Model::default();
    let entries = std::fs::read_dir(dir).map_err(|source| LoadError::Io {
        path: dir.display().to_string(),
        source,
    })?;
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| LoadError::Io {
            path: dir.display().to_string(),
            source,
        })?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if matches!(ext, "yml" | "yaml" | "json") {
            paths.push(path);
        }
    }
    // Deterministic merge order (later files win on conflicts).
    paths.sort();
    for path in paths {
        let contents = std::fs::read_to_string(&path).map_err(|source| LoadError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let m = parse_str(&contents, &path.display().to_string())?;
        model.merge(m);
    }
    // Cross-reference validation runs on the MERGED model — a join or label
    // may legitimately point at a cube defined in another file.
    model
        .validate()
        .map_err(|problems| LoadError::Invalid { dir: dir.display().to_string(), problems })?;
    Ok(model)
}
