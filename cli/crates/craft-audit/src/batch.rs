//! A profile's files cut into batches of whole files, each under the run's byte budget: a lens
//! agent reads one batch whole. A file never splits; one larger than the budget is a batch alone.

use serde::{Deserialize, Serialize};

/// A tracked file and its size in the working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tracked {
    pub path: String,
    pub bytes: u64,
}

/// Whole files one lens agent reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub files: Vec<Tracked>,
}

impl Batch {
    /// What its files weigh together.
    #[must_use]
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.bytes).sum()
    }

    /// Its files' paths, in order.
    #[must_use]
    pub fn paths(&self) -> Vec<String> {
        self.files.iter().map(|f| f.path.clone()).collect()
    }
}

/// `files` in order, cut into batches whose bytes stay within `budget`; a file over it alone.
#[must_use]
pub fn batches(files: &[Tracked], budget: u64) -> Vec<Batch> {
    let mut out: Vec<Batch> = Vec::new();
    let mut current = Batch::default();
    for f in files {
        if !current.files.is_empty() && current.bytes().saturating_add(f.bytes) > budget {
            out.push(std::mem::take(&mut current));
        }
        current.files.push(f.clone());
    }
    if !current.files.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Tracked, batches};

    fn files(sizes: &[u64]) -> Vec<Tracked> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, &bytes)| Tracked {
                path: format!("f{i}"),
                bytes,
            })
            .collect()
    }

    fn shape(sizes: &[u64], budget: u64) -> Vec<Vec<String>> {
        batches(&files(sizes), budget)
            .iter()
            .map(super::Batch::paths)
            .collect()
    }

    #[test]
    fn files_fill_a_batch_up_to_the_budget_exactly_and_the_next_one_opens_a_new_batch() {
        assert_eq!(
            shape(&[4, 6, 1, 9], 10),
            [vec!["f0", "f1"], vec!["f2", "f3"]]
        );
    }

    #[test]
    fn a_file_over_the_budget_is_a_batch_alone_and_never_split() {
        let got = batches(&files(&[3, 50, 3]), 10);
        assert_eq!(got.len(), 3);
        assert_eq!(got[1].bytes(), 50);
        assert_eq!(got[1].paths(), ["f1"]);
    }

    #[test]
    fn no_file_is_no_batch_and_every_file_lands_once_in_order() {
        assert!(batches(&[], 10).is_empty());
        let all: Vec<String> = shape(&[7, 7, 7, 2, 2], 9).concat();
        assert_eq!(all, ["f0", "f1", "f2", "f3", "f4"]);
    }
}
