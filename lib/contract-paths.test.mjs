// Direct tests of lib/contract-paths.mjs: each contract class forces the compat surface on, named by
// the class it must land in, and prose, test inputs and ordinary source do not.
// lib/review-surface-gating.test.mjs drives the same predicate through the whole engine.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { contractPathClass, isContractOrSchemaPath, CONTRACT_PATH_CLASSES } from './contract-paths.mjs'

/** @type {Record<string, string[]>} */
const POSITIVE = {
  'contracts-crate': ['crates/foo-contracts/src/lib.rs', 'crates/contracts/src/vm.rs'],
  'crd-dir': ['charts/op/crds/cloudless.dev.yml', 'deploy/crds/thing.yaml'],
  'crd-manifest': ['config/crd/bases/widgets-crd.yaml', 'manifests/customresourcedefinition.yaml', 'k8s/crds.json'],
  'helm-chart': ['charts/op/Chart.yaml', 'Chart.yml'],
  'helm-values': ['charts/op/values.yaml', 'values-prod.yaml', 'helm/app/values.schema.yaml'],
  'helm-template': ['charts/op/templates/deployment.yaml', 'helm/app/templates/_helpers.tpl'],
  'openapi': ['api/openapi.yaml', 'docs/swagger.json', 'spec/openapi-v2.yml'],
  'proto': ['proto/vm/v1/vm.proto'],
  'graphql': ['schema/schema.graphql', 'api/types.graphqls', 'src/queries.gql'],
  'avro': ['schemas/event.avsc', 'schemas/protocol.avdl', 'schemas/svc.avpr'],
  'json-schema': ['schemas/config.schema.json', 'schema.json', 'spec/thing.jsonschema'],
  'db-migration': ['migrations/0001_init.sql', 'db/migrate/20240101_add.rb', 'alembic/versions/abc.py', 'crates/store/migration/v2.sql'],
  'plugin-manifest': ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'],
}

// Driven by the expected classes, not by the table: a class dropped from the table turns ITS test red.
for (const [name, paths] of Object.entries(POSITIVE)) {
  test(`class ${name}: its paths force the compat surface on`, () => {
    for (const p of paths) {
      assert.equal(contractPathClass(p), name, `${p} is ${name}`)
      assert.equal(isContractOrSchemaPath(p), true, `${p} forces compat`)
    }
  })
}

test('every class the table declares has positive cases here', () => {
  for (const c of CONTRACT_PATH_CLASSES) assert.ok(POSITIVE[c.name]?.length, `${c.name} has positive cases`)
})

test('prose never forces compat, even beside or about a contract', () => {
  for (const p of ['docs/api.md', 'charts/op/README.md', 'proto/CHANGES.rst', 'migrations/NOTES.txt', 'docs/openapi.mdx', 'crds/README.adoc']) {
    assert.equal(isContractOrSchemaPath(p), false, `${p} is prose`)
  }
})

test('test inputs never force compat, at any depth and in any case', () => {
  for (const p of [
    'tests/fixtures/crds/widget.yaml', 'lib/__tests__/schema.graphql', 'pkg/testdata/openapi.yaml',
    'fixtures/migrations/0001.sql', 'src/Test/vm.proto', 'charts/op/tests/values.yaml', 'x/__snapshots__/a.avsc',
    'e2e/__fixtures__/.claude-plugin/plugin.json',
  ]) {
    assert.equal(isContractOrSchemaPath(p), false, `${p} is a test input`)
  }
})

test('ordinary source and look-alikes do not force compat', () => {
  for (const p of [
    'src/lib.rs', 'crates/core/src/contracts.rs', 'package.json', 'opencode/plugin/package.json',
    'config/values.yaml', '.github/workflows/ci.yml', 'templates/email.html', 'site/templates/page.yaml',
    'src/swagger.ts', 'src/openapi_client.rs', 'docker-compose.yaml', 'src/migration_helper.rs',
    'plugin.json', 'lib/schema.mjs', '', '.', null, undefined,
  ]) {
    assert.equal(isContractOrSchemaPath(p), false, `${String(p)} is not a contract path`)
  }
})

test('a path that climbs or is spelled with backslashes is judged on its normalized segments', () => {
  assert.equal(contractPathClass('charts\\op\\Chart.yaml'), 'helm-chart')
  assert.equal(contractPathClass('./charts/./op/templates/svc.yaml'), 'helm-template')
  assert.equal(contractPathClass('tests/../proto/a.proto'), 'proto', 'a popped tests/ segment no longer excludes it')
})
