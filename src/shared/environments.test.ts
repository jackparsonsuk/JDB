import { describe, expect, it } from 'vitest'
import { allEnvironments, envIdFor, envInfo, environmentCss, mergeEnvironments, parseEnvironments, safetyOf } from './environments'

const uat = { id: 'uat', name: 'UAT', safety: 'confirm' as const, color: '#a371f7' }
const staging = { id: 'staging', name: 'Staging', safety: 'protected' as const, color: '#f0883e' }

describe('environments', () => {
  it('keeps built-ins first and knows their safety', () => {
    expect(allEnvironments([uat]).map((e) => e.id)).toEqual(['local', 'dev', 'test', 'prod', 'uat'])
    expect(['local', 'dev', 'test', 'prod', 'uat'].map((id) => safetyOf(id, [uat]))).toEqual(['relaxed', 'confirm', 'confirm', 'protected', 'confirm'])
  })

  it('treats an environment it does not know as protected', () => {
    expect(envInfo('gone', [uat])).toMatchObject({ id: 'gone', name: 'gone', safety: 'protected' })
  })

  it('makes ids from names without clashing with built-ins or others', () => {
    expect(envIdFor('UAT 2', [])).toBe('uat-2')
    expect(envIdFor('Prod', [])).toBe('prod-2')
    expect(envIdFor('UAT', ['uat'])).toBe('uat-2')
    expect(envIdFor('  2nd line!  ', [])).toBe('env-2nd-line')
    expect(envIdFor('***', [])).toBe('env')
  })

  it('drops invalid, duplicate and built-in entries when reading', () => {
    expect(parseEnvironments([
      uat,
      { ...uat, name: 'Again' },
      { id: 'prod', name: 'Mine', safety: 'relaxed', color: '#000000' },
      { id: 'Bad Id', name: 'x', safety: 'confirm' },
      { id: 'ok', name: 'OK', safety: 'loose' },
      { id: 'nocolor', name: 'No colour', safety: 'relaxed', color: 'red' },
      'junk'
    ])).toEqual([uat, { id: 'nocolor', name: 'No colour', safety: 'relaxed', color: '#8b949e' }])
    expect(parseEnvironments(null)).toEqual([])
  })

  it('never lets a shared file loosen or replace an environment', () => {
    const looser = { ...staging, safety: 'relaxed' as const, name: 'Staging (theirs)' }
    const { environments, added } = mergeEnvironments([staging], [looser, uat, { id: 'prod', name: 'Prod', safety: 'relaxed', color: '#000000' }])
    expect(environments).toEqual([staging, uat])
    expect(added).toEqual(['UAT'])
  })

  it('writes a colour rule per custom environment', () => {
    expect(environmentCss([uat, staging])).toBe('.env-uat { --env-color: #a371f7; }\n.env-staging { --env-color: #f0883e; }')
  })
})
