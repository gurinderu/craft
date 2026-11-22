//! A coverage gap as the run record's `capped` holds it: its stable key — the lens and the kind of
//! gap — then, after [`SEP`], the detail of its run (files, errors). Every writer of a gap builds it
//! with [`entry`]; the readers that rank gaps across runs (`craft runs retro`, [`key`], and
//! `gapKeys` in `integrations/shared/analyze-runs.mjs`) undo it: the text before the first [`SEP`].

/// What parts a gap's key from its detail.
pub const SEP: &str = " — ";

/// The gap `key` (which holds no [`SEP`]) with its `detail`.
#[must_use]
pub fn entry(key: &str, detail: &str) -> String {
    debug_assert!(!key.contains(SEP), "a gap's key holds no separator: {key}");
    format!("{key}{SEP}{detail}")
}

/// [`entry`]'s inverse for ranking: the key, the text before the first [`SEP`]; a gap written
/// with none is its own key, kept whole.
#[must_use]
pub fn key(gap: &str) -> &str {
    gap.split_once(SEP).map_or(gap, |(k, _)| k)
}

#[cfg(test)]
mod tests {
    use super::{entry, key};

    #[test]
    fn the_key_is_what_comes_before_the_first_separator() {
        let g = entry(
            "metrics-only lens complexity could not look",
            "a.rs — cut — again",
        );
        assert_eq!(key(&g), "metrics-only lens complexity could not look");
        assert_eq!(key("a gap with no separator"), "a gap with no separator");
    }
}
