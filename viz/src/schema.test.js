// Validates the committed model against the JSON Schema contract (schema/*.schema.json). Catches
// structural drift — a renamed/dropped field, a wrong type — the kind of thing that silently
// breaks the viz. The schema asserts shape; guard-data.mjs owns enum + referential rules.
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import main from '../../fe-architecture.json'
import extras from '../../fe-architecture-extras.json'
import mainSchema from '../../schema/fe-architecture.schema.json'
import extrasSchema from '../../schema/fe-architecture-extras.schema.json'

const ajv = new Ajv({ allErrors: true, strict: false })

describe('data schema', () => {
  it('fe-architecture.json matches its schema', () => {
    const validate = ajv.compile(mainSchema)
    const ok = validate(main)
    if (!ok) console.error(validate.errors)
    expect(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2)).toBe(true)
  })

  it('fe-architecture-extras.json matches its schema', () => {
    const validate = ajv.compile(extrasSchema)
    const ok = validate(extras)
    if (!ok) console.error(validate.errors)
    expect(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 2)).toBe(true)
  })
})
