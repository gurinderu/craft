//! The engine's one script, evaluated when it starts.

/// Defined once per engine: every `RegExp` is compiled once and reused, and a batch of texts is
/// matched in one call, so a manifest's lines cost a few calls, not a few evaluations each.
pub(super) const SETUP: &str = r#"(() => {
    const cache = new Map();
    const compile = (source, flags) => {
        const key = flags + "\u0000" + source;
        let re = cache.get(key);
        if (re === undefined) {
            if (cache.size >= 4096) cache.clear();
            re = new RegExp(source, flags);
            cache.set(key, re);
        }
        re.lastIndex = 0;
        return re;
    };
    globalThis.__craftExec = (source, flags, texts) => {
        let re;
        try { re = compile(source, flags); }
        catch (e) { return JSON.stringify({error: e.message}); }
        return JSON.stringify(texts.map((text) => re.exec(text)));
    };
    globalThis.__craftExecJson = (input) => {
        const [source, flags, text] = JSON.parse(input);
        return globalThis.__craftExec(source, flags, [text]);
    };
})()"#;
