// Validates the committed model against its JSON Schema contract (schema/*.schema.json), catching
// structural drift such as a renamed field or a wrong type that would silently break the viz.
// The schema asserts shape only; guard-data.mjs owns enum and referential rules.
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import main from '../../fe-architecture.json'
import extras from '../../fe-architecture-extras.json'
import mainSchema from '../../schema/fe-architecture.schema.json'
import extrasSchema from '../../schema/fe-architecture-extras.schema.json'

const ajv = new Ajv({ allErrors: true, strict: false })
const ERRORS_SHOWN = 5

function expectValid(schema, document) {
  const validate = ajv.compile(schema)
  const valid = validate(document)
  if (!valid) console.error(validate.errors)
  expect(valid, JSON.stringify(validate.errors?.slice(0, ERRORS_SHOWN), null, 2)).toBe(true)
}

describe('data schema', () => {
  it('fe-architecture.json matches its schema', () => {
    expectValid(mainSchema, main)
  })

  it('fe-architecture-extras.json matches its schema', () => {
    expectValid(extrasSchema, extras)
  })
})
