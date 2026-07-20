# Changelog

## [0.13.1](https://github.com/gurinderu/craft/compare/v0.13.0...v0.13.1) (2026-07-20)


### Bug Fixes

* **review:** close re-review coverage holes (full re-scan cadence + ledger-degradation guard) ([ee8cf79](https://github.com/gurinderu/craft/commit/ee8cf798000472fde4dddac6bc6873ac7a5d14e7))

## [0.13.0](https://github.com/gurinderu/craft/compare/v0.12.0...v0.13.0) (2026-07-19)


### Features

* **review:** adjudicate schema requires invariant+attack; add ATTACK_SCHEMA + lint guard ([cb6a394](https://github.com/gurinderu/craft/commit/cb6a394077a9b6ceec0e86bdb60238da900ae5cb))
* **review:** fix-completeness adjudication — invariant+attack method, red-team pass for resolved Crit/High priors ([34c5253](https://github.com/gurinderu/craft/commit/34c52536299c4a789fa43bd2b505567d844b46a1))


### Bug Fixes

* **review:** canonicalize prior-ledger severity for the verdict path, preserve identifiers in prompt fields, persist sources for strict re-review escalation ([9b14d67](https://github.com/gurinderu/craft/commit/9b14d6770f1a44d9a76c0c2803e7a283eef94bca))
* **review:** guard model-authored fields in the round-1 verifyPrompt ([873f8dd](https://github.com/gurinderu/craft/commit/873f8dd39cf1343c06f55e7b8e9fef262f608e9d))
* **review:** harden adjudicate track — demote contradictory resolved+attack, audit red-team death, reject empty-attack defeat, bound attack text ([bc5dd1b](https://github.com/gurinderu/craft/commit/bc5dd1ba4f95999a450389910fac0c6d10a210ee))
* **review:** sanitize all adjudicate-track text, audit every degraded verdict, harden why bookkeeping ([0733b07](https://github.com/gurinderu/craft/commit/0733b07b49c70fc56b714138e6d3fc06ac2b9b7e))
* **review:** sanitize model-authored fields at all three adjudicate prompt sites; cover still-open path; reconcile baseWhy comment ([ea44ad7](https://github.com/gurinderu/craft/commit/ea44ad79a1310629bf9c5d3a80281147c7e0f45d))
* **review:** shq/flatten all model-authored refs into shell + prompts (round 3b) ([af29dc5](https://github.com/gurinderu/craft/commit/af29dc586a2e40b4b50505507be64cf3e815e0a0))
* **review:** single-quote shell args in the carry-check git diff, validate ledger head ([f207a14](https://github.com/gurinderu/craft/commit/f207a149b14dbdd35c5728791be644cc6b291c00))
* **review:** stop baseWhy residue accreting when attack text echoes a marker ([6c11987](https://github.com/gurinderu/craft/commit/6c11987db83991c51d4b78d650744d08b5abd009))
* **review:** strip new why-suffixes in baseWhy, flatten file/severity into prompts, audit carry-death, case-insensitive severity gate ([363e76a](https://github.com/gurinderu/craft/commit/363e76ae93eb0d9ae9576694d422b114ceaa3229))

## [0.12.0](https://github.com/gurinderu/craft/compare/v0.11.0...v0.12.0) (2026-07-15)


### Features

* **review:** adjudicate track for prior-round findings ([f7b50e1](https://github.com/gurinderu/craft/commit/f7b50e1c552d15891827ba02667c5889d26b6d99))
* **review:** auto-detect re-review round with ancestor guard ([b0b1d9d](https://github.com/gurinderu/craft/commit/b0b1d9db989884e29f12bdf688c312f4a1b3da90))
* **review:** delta-scoped lenses and re-review report shape ([a558d8f](https://github.com/gurinderu/craft/commit/a558d8f1cfb4cc7a494faba7ba1761f05dc2e33e))
* **review:** disposition mapping and re-review verdict ([675ae5e](https://github.com/gurinderu/craft/commit/675ae5ef619d9805e95d35cc3b045acd8b9e68c7))
* **review:** fuzzy cross-round finding matching ([83b8958](https://github.com/gurinderu/craft/commit/83b8958638d0ed472e814ce7100e67f810a698aa))
* **review:** line-tolerant finding fingerprint helper ([187dff8](https://github.com/gurinderu/craft/commit/187dff874320236f24f2cddb7574ffccc602925e))
* **review:** persist full finding ledger with branch/head/round ([2a2f5c1](https://github.com/gurinderu/craft/commit/2a2f5c1bed08f1d4da23387d748bfae2681eaf1d))
* **review:** prior-round selection and index branch/head/round ([7e99f86](https://github.com/gurinderu/craft/commit/7e99f86bd82cfb4d5038c9eca13edde8f5d92b47))


### Bug Fixes

* **review:** carry ledger across rounds, decouple ledger schema, re-review-aware fallback + verdict ([5f4f883](https://github.com/gurinderu/craft/commit/5f4f8837ac87f02d8b94cd1f880bbf116768edbc))
* **review:** escape backticks in rust scoutRules so it evaluates to the intended string ([92ced71](https://github.com/gurinderu/craft/commit/92ced71579cb9e06b4e81aef9ec137e2425437ca))
* **review:** sync workflow indexProjection with branch/head/round ([fa14895](https://github.com/gurinderu/craft/commit/fa14895de88db0f2bd9cfba6b6f9aff0b75f3ebd))

## [0.11.0](https://github.com/gurinderu/craft/compare/v0.10.0...v0.11.0) (2026-07-15)


### Features

* **review:** add compat lens and sibling-divergence invariants clause ([2bf9064](https://github.com/gurinderu/craft/commit/2bf90643f60bff0515ee4bda5342b211c3e3e1b5))
* **review:** harden reconciler lens for requeue-gap and watch-poisoning ([3c5536e](https://github.com/gurinderu/craft/commit/3c5536e1a12b4fcb32f3e0e759e3e5e84c5ba88b))


### Bug Fixes

* **addressing-findings:** gather PR comments via GraphQL reviewThreads ([034493a](https://github.com/gurinderu/craft/commit/034493a9d7c9a22ad5705a5fc230db878cbee90e))

## [0.10.0](https://github.com/gurinderu/craft/compare/v0.9.0...v0.10.0) (2026-07-14)


### Features

* **analyze-runs:** rank lenses by per-lens refute rate ([515a198](https://github.com/gurinderu/craft/commit/515a198ba7e652bde4f8f2ab7c733110c2050ca5))

## [0.9.0](https://github.com/gurinderu/craft/compare/v0.8.0...v0.9.0) (2026-07-14)


### Features

* **review:** tighten api-idioms lens — high-value breaks over completeness nits ([ca8f28d](https://github.com/gurinderu/craft/commit/ca8f28d37cf94feb291dfcc6b0deb6d5535142f8))

## [0.8.0](https://github.com/gurinderu/craft/compare/v0.7.0...v0.8.0) (2026-07-14)


### Features

* **review:** staged cheap-model verification and per-lens refute telemetry ([9994907](https://github.com/gurinderu/craft/commit/999490749564e4e75175be47f36d7c4ecc970b2b))

## [0.7.0](https://github.com/gurinderu/craft/compare/v0.6.0...v0.7.0) (2026-07-14)


### Features

* **review:** add reconciler lens and a resurrection sweep for transient lens deaths ([8fb53b3](https://github.com/gurinderu/craft/commit/8fb53b33a216bcaef9c293ed594b608b1c702e95))
* **review:** harden the engine to catch invariant, coverage, spec & API-boundary defects ([e35d1fc](https://github.com/gurinderu/craft/commit/e35d1fcc1cc413974afad99fa975535d5847865e))

## [0.6.0](https://github.com/gurinderu/craft/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* **observability:** add run-record analyzer for the self-improvement loop ([d9cc4d3](https://github.com/gurinderu/craft/commit/d9cc4d3ffa79f74d4db85e624a7a53ab23c5e3ba))


### Bug Fixes

* **review:** harden against missing plugin agent types; verify dep-context by reasoning ([2ca957e](https://github.com/gurinderu/craft/commit/2ca957e6cec9dc0d8056541b6b1855384786bb59))
* **review:** probe reviewer-agent up front; keep maintainability source through dedup ([9eb1fb2](https://github.com/gurinderu/craft/commit/9eb1fb2ecaa532e33d7ed09770ca700333214d39))

## [0.5.0](https://github.com/gurinderu/craft/compare/v0.4.1...v0.5.0) (2026-07-09)


### Features

* **review:** harden the engine against API deaths and close smoke-run gaps ([4d993bd](https://github.com/gurinderu/craft/commit/4d993bd70086082f7b6cc9174eebbd2b87734dc0))

## [0.4.1](https://github.com/gurinderu/craft/compare/v0.4.0...v0.4.1) (2026-07-09)


### Bug Fixes

* **review:** close verification blind spots found by the smoke run ([77834ae](https://github.com/gurinderu/craft/commit/77834aef0f4a2ae21c404f50e4883106c23a505c))

## [0.4.0](https://github.com/gurinderu/craft/compare/v0.3.0...v0.4.0) (2026-07-08)


### Features

* **nix-flakes:** add nix-flakes domain skill ([dbb6a01](https://github.com/gurinderu/craft/commit/dbb6a014c7191c17011c2ca9e67af8c113c619b4))
* **nix:** add nix-dev-env skill (devShells, direnv, linters) ([d807816](https://github.com/gurinderu/craft/commit/d8078163238c48678c2845059dfe9aa5ec4bd654))
* **nix:** add nix-packaging skill (derivations, builders) ([45e7cc4](https://github.com/gurinderu/craft/commit/45e7cc4bb4ed6722494a2962d331861713c59717))
* **nix:** add nix-review rubric skill rule catalog ([034585b](https://github.com/gurinderu/craft/commit/034585b6b5a19bb1cbaa5a12b15f64ec708373ed))
* **nix:** add nix-review workflow pin ([7c267b8](https://github.com/gurinderu/craft/commit/7c267b895cd422f80792e8e7e81f549ec322bd3f))
* **nix:** add nix-reviewer agent ([7e551d0](https://github.com/gurinderu/craft/commit/7e551d05eb54668a85eb1006697e1e6a26d82949))
* **nix:** add nixos skill (modules, home-manager, secrets) ([be27173](https://github.com/gurinderu/craft/commit/be271738fe34481eac05fde708f3a710f8116ecb))
* **review:** PROFILES.nix + auto-detect + multi-language merge ([1acda93](https://github.com/gurinderu/craft/commit/1acda932da8b03b991c9f9de574cbc1ef1eb3ff0))
* **rust-review:** security rigor floor, negative-space lens, INCOMPLETE tracking ([d0f9667](https://github.com/gurinderu/craft/commit/d0f96677ad45b3cf517b87076d55406d5773d229))
* **rust:** add rust-ml skill, ID-tagged review rule catalog, dependency-aware review ([6358b35](https://github.com/gurinderu/craft/commit/6358b350c1daeb15d2372ce5a8f7341be098aecb))


### Bug Fixes

* **nix-flakes:** drop arg shadow in example, offline checks.fmt, verbatim description ([372e7d0](https://github.com/gurinderu/craft/commit/372e7d06bd648950106aad37d610bb34e10fd8ad))
* **review:** restore negative-space plan.intent and rust cargo-mutants tests hint ([d88fae0](https://github.com/gurinderu/craft/commit/d88fae092b26f6b8cbc42b3def9c8e4ed96e43b7))

## [0.3.0](https://github.com/gurinderu/craft/compare/v0.2.0...v0.3.0) (2026-07-07)


### Features

* **strict-review:** add subscription-friendly adversarial diff review workflow ([4da7101](https://github.com/gurinderu/craft/commit/4da710188f21557d9f9264fc5d0766d10a634c4d))


### Bug Fixes

* **opencode:** make skill descriptions valid YAML ([eff3cd9](https://github.com/gurinderu/craft/commit/eff3cd95709b1be9ba05090a950138173e659d70))
* **opencode:** make skill descriptions valid YAML ([9969e57](https://github.com/gurinderu/craft/commit/9969e5731b5679c2f3eacaf9c9bd82f0901f571a))

## [0.2.0](https://github.com/gurinderu/craft/compare/v0.1.0...v0.2.0) (2026-06-30)


### Features

* **addressing-findings:** add the fix-loop skill entry ([0985716](https://github.com/gurinderu/craft/commit/09857161ec591a78ad7374a329be2629dae0ed0b))
* **models:** run security, miri, and review agents on Opus ([b14055b](https://github.com/gurinderu/craft/commit/b14055b44d1a9325f9ba80136a8b4a230a64a109))
* **models:** tier review agents by task across both hosts ([21522f0](https://github.com/gurinderu/craft/commit/21522f0c0855603ea93399ea9df0596888a1b1c6))
* **observability:** add explicit runtime field to records ([0e54fcd](https://github.com/gurinderu/craft/commit/0e54fcd4374f241ccbeec787c1927df2c0c8fc85))
* **observability:** emit a run record from rust-audit ([7b3c0c8](https://github.com/gurinderu/craft/commit/7b3c0c89dbfe8debd68703188c1b911119316c91))
* **observability:** emit a run record from rust-review (all paths) ([9aa2e04](https://github.com/gurinderu/craft/commit/9aa2e0488a23c021b144c60928c9bd9cc4dbc3a6))
* **observability:** emit run records from the triage-findings workflow ([dc77b01](https://github.com/gurinderu/craft/commit/dc77b0155501673764f04c8afb032761ed956105))
* **observability:** standalone agents self-log run records ([9407b47](https://github.com/gurinderu/craft/commit/9407b470c12ef2a54fd76c3f15de7dbe4aaa2259))
* **observability:** tested run-record shaping helpers ([f5e317b](https://github.com/gurinderu/craft/commit/f5e317b5b748f47f5d9bb38a503c467bcd512e22))
* **opencode:** /rust-audit and /triage-findings command entry points ([3396b2d](https://github.com/gurinderu/craft/commit/3396b2d01a85749cb763477be88a6779933647f2))
* **opencode:** add symlink installer (--project default, --global opt-in) ([e49c084](https://github.com/gurinderu/craft/commit/e49c0847ace7cc3e941836036e843c992af8ec8b))
* **opencode:** add the four review agent adapters ([98475d9](https://github.com/gurinderu/craft/commit/98475d95e9b32c9f86f51f39417623ec5ab1b0a4))
* **opencode:** bring review agents to parity with the Claude Code versions ([4668a0d](https://github.com/gurinderu/craft/commit/4668a0df1a52ecc65163804a0b97d50a732d3ccc))
* **opencode:** child-session fan-out with sequential fallback for [#8528](https://github.com/gurinderu/craft/issues/8528)/[#6573](https://github.com/gurinderu/craft/issues/6573) ([98b9e43](https://github.com/gurinderu/craft/commit/98b9e433819074dafb633cfb23cb0e26cfe000a3))
* **opencode:** emit run records from /rust-audit and /triage-findings ([29f7143](https://github.com/gurinderu/craft/commit/29f714394f10ffcf421596c823a01b2b0f36c2ac))
* **opencode:** plugin scaffold — register two tools, zero global hooks ([26e8293](https://github.com/gurinderu/craft/commit/26e8293620a5e1379f2cf27ceb154abd22b7f3f7))
* **opencode:** port the whole-project audit tool dimensions ([810e663](https://github.com/gurinderu/craft/commit/810e6637461f308381774b78a1be9a8792c9f768))
* **opencode:** run-record module for observability ([b1c1197](https://github.com/gurinderu/craft/commit/b1c1197ac7e4772dedf8a5a559d8da7a573d1d7d))
* **opencode:** rust-audit workflow — scout, fan out reviewers, synthesize ([512686d](https://github.com/gurinderu/craft/commit/512686d1e8620e9692a77971f40b7098e0a492ea))
* **opencode:** triage-findings workflow — validate per finding, render fix plan ([ff3dfed](https://github.com/gurinderu/craft/commit/ff3dfed2ffbca452dc152d5c5d873f0edd5fd4d2))
* **rust-audit:** carry gate provenance from review dimension into synthesis ([edccc3c](https://github.com/gurinderu/craft/commit/edccc3cbd4794d71577d1695bccc6e797396158f))
* **rust-audit:** crate-decomposition dimension (when/how to extract a crate) ([6181656](https://github.com/gurinderu/craft/commit/6181656b186ba064ffc5cda7a730ebed20df85b6))
* **rust-audit:** delegate the review dimension to the rust-review workflow ([c7d0120](https://github.com/gurinderu/craft/commit/c7d0120a6cd0c15a434bb0527f2c7b5afde7fc26))
* **rust-audit:** inter-crate contract review per dependency edge ([a05718a](https://github.com/gurinderu/craft/commit/a05718a14f907ac8a8b1b94bd400403951edd5b8))
* **rust-audit:** per-crate parallel review fan-out ([6de3882](https://github.com/gurinderu/craft/commit/6de38821caf4fb03b565567bde2c8abbb89ce15e))
* **rust-audit:** semver / build-matrix / deps / tests-cov tool dimensions ([3a1aeb8](https://github.com/gurinderu/craft/commit/3a1aeb842a6f2916674b36e1f37c27720639756c))
* **rust-audit:** surface dropped audit dimensions as NOT RUN ([79fee3b](https://github.com/gurinderu/craft/commit/79fee3b90c9fb1d356ea4c52c283ecb5ca62470f))
* **rust-audit:** synthesis + meta for the comprehensive dimension set ([c941c9b](https://github.com/gurinderu/craft/commit/c941c9b46291be98e0b09865e1b51e08cd98505a))
* **rust-audit:** verified unused-crate detection dimension ([227b98c](https://github.com/gurinderu/craft/commit/227b98cedb78228b5013e3462b754169627a806b))
* **rust-concurrency:** note parking_lot as the non-poisoning lock alternative ([1e3067f](https://github.com/gurinderu/craft/commit/1e3067fd3362c3985c8d505494e6cfce44477f69))
* **rust-embedded:** add bare-metal/MCU no_std domain skill ([4639466](https://github.com/gurinderu/craft/commit/46394669bbc31d989cfced8ff28d2cbb875b24dc))
* **rust-miri:** consume a green CI miri check when present ([7d44d8b](https://github.com/gurinderu/craft/commit/7d44d8bd535e94562f5414265f5c2682efe3946c))
* **rust-navigation:** add LSP navigation skill, lifecycle patterns, 3-strike rule ([affe3c7](https://github.com/gurinderu/craft/commit/affe3c7814a60c10d0e73acbb9b43fc16b5332a8))
* **rust-performance:** add allocator swap, buffered I/O, dhat, and more ([5163b56](https://github.com/gurinderu/craft/commit/5163b56b622288cc74af8ad0d3b5823231b528d0))
* **rust-performance:** add arenas, compact strings, PGO, SIMD, code layout ([9e830db](https://github.com/gurinderu/craft/commit/9e830dbcca404d8855bfc2961628c8c60b48444b))
* **rust-review:** add maintainability lens with strict presumption-of-block mode ([47c0e54](https://github.com/gurinderu/craft/commit/47c0e5472ae0d62df3f5f06ea338ca8c15425843))
* **rust-review:** add public-API design pass against the Rust API Guidelines ([a20e967](https://github.com/gurinderu/craft/commit/a20e9676ac1c183909eae7e8ac8e66a576107d8b))
* **rust-review:** add semgrep as a SAST seed source in the gate ([ad1b794](https://github.com/gurinderu/craft/commit/ad1b794b9986545c40b5ed13ad54481127c3fe5d))
* **rust-review:** adversarial + self-verification with Confirmed/Suspected tiers ([aec5934](https://github.com/gurinderu/craft/commit/aec593438cfa3e4447656596eaa8e9998b54b3ec))
* **rust-review:** calibrated synthesis, completeness critic, optional PR comments ([b7cc758](https://github.com/gurinderu/craft/commit/b7cc758fb8d8cf65adc9c339b0440975a429dc66))
* **rust-review:** CI-aware gate phase with tool-grounded seed findings ([1cad7bc](https://github.com/gurinderu/craft/commit/1cad7bc04e750c62f39fba0208b13afdc20d1b32))
* **rust-reviewer:** consume CI gate signal, fall back to local ([48ddf57](https://github.com/gurinderu/craft/commit/48ddf573a0a3ecce1a7e20b54ac19efad2f31724))
* **rust-review:** loop-until-dry rounds with cross-round dedup ([fbfe6f8](https://github.com/gurinderu/craft/commit/fbfe6f8981aaff9a44f7ddab214d015a450f66c9))
* **rust-review:** make the mechanical gate CI-aware (canonical protocol) ([9108544](https://github.com/gurinderu/craft/commit/910854417206e4cad730c9001fbaec458680da8c))
* **rust-review:** optional path arg to scope the review to one crate ([3a7a10b](https://github.com/gurinderu/craft/commit/3a7a10b92eabf0d2eefd548400b8a6c976db70f5))
* **rust-review:** per-lens fan-out with context expansion and blast-radius ([32fe19d](https://github.com/gurinderu/craft/commit/32fe19d87139ce7e0ae492772ba866db6282a2bf))
* **rust-review:** scaffold elastic review workflow with scout phase ([f3d935b](https://github.com/gurinderu/craft/commit/f3d935bafa502a7a7979391d471c9371c63e1a3c))
* **rust-security-scanner:** consume CI audit/deny checks when green ([e885518](https://github.com/gurinderu/craft/commit/e88551861c71af045c7a7995a0046750aec4be23))
* **triage-findings:** add the triage→fix-plan workflow ([3cef3b9](https://github.com/gurinderu/craft/commit/3cef3b9ac1c7e63e076ccdb6db12857461aa756c))


### Bug Fixes

* **observability:** hoist stripInternal; document gate/dimensions-scope record fields ([8280220](https://github.com/gurinderu/craft/commit/828022002aec516f3535e68f1d5d30ede52d31dd))
* **opencode:** fail-safe unsafe detection in rust-audit (run Miri when detection doesn't resolve) ([ef66979](https://github.com/gurinderu/craft/commit/ef6697921b1e0a5a1d9505eb14c3a273f1076815))
* **opencode:** non-numeric skill count in docs; guard extractText against array SDK responses ([8650b6d](https://github.com/gurinderu/craft/commit/8650b6d29bc93a11d888b881d39783f7a0036413))
* **opencode:** read triage locator via FS, not a shell (closes command injection) ([83f2d66](https://github.com/gurinderu/craft/commit/83f2d6604151d7fc290f0cb5c5f5cf7e57ec28ab))
* **opencode:** word-boundary parseVerdict to avoid prose false-positives ([31d3071](https://github.com/gurinderu/craft/commit/31d307134a3a822787b122847af00ce4601780f9))
* **plugin:** qualify superpowers dependency with its marketplace ([96faaa6](https://github.com/gurinderu/craft/commit/96faaa6a31983376d099341427761534b4979259))
* **review:** accumulate critic dropped count; harden triage null paths ([43d4e79](https://github.com/gurinderu/craft/commit/43d4e79aafe309878b7d1008f68bbe462607ad34))
* **rust-audit:** guard against null agent results ([4027c3b](https://github.com/gurinderu/craft/commit/4027c3b110838d53cd60b5de69057b70a8689e53))
* **rust-audit:** qualify agentType with the craft plugin prefix ([94367e2](https://github.com/gurinderu/craft/commit/94367e2ac7b5d4f9dc5cc3275ac6034650130855))
* **triage-findings:** accept args passed as a JSON string, not just an object ([23bc540](https://github.com/gurinderu/craft/commit/23bc540b352a2051ada5c3b2144f51bf896f8dd9))
