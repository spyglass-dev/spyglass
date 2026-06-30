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
}

/// Parse one definition file's contents into a [`Model`] (accepts a full model
/// or a single cube). YAML parsing also accepts JSON.
pub fn parse_str(contents: &str, path_for_errors: &str) -> Result<Model, LoadError> {
    let value: serde_yaml::Value =
        serde_yaml::from_str(contents).map_err(|source| LoadError::Parse {
            path: path_for_errors.to_string(),
            source,
        })?;
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
        serde_yaml::from_value(value).map_err(|source| LoadError::Parse {
            path: path_for_errors.to_string(),
            source,
        })
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
    Ok(model)
}
