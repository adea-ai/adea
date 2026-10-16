import { describe, expect, test } from 'bun:test'

import config, { previewEnv, productionEnv } from '../cloudflare.config'

type Resolved = {
  accountId: string
  worker: { env: Record<string, { type: string; [key: string]: unknown }> }
}
const evaluate = (context: { isPreview: boolean; mode: string | undefined }) =>
  (config as unknown as (context: unknown) => Resolved)(context)

const productionEnvironment = productionEnv() as unknown as Resolved['worker']['env']
const productionHyperdriveId = productionEnvironment.HYPERDRIVE!.id as string
const productionStoreId = (productionEnvironment.DATABASE_URL as { storeId: string }).storeId

const selection = {
  ADEA_PREVIEW_HYPERDRIVE_ID: '11111111111111111111111111111111',
  ADEA_PREVIEW_SECRETS_STORE_ID: '22222222222222222222222222222222',
  ADEA_PREVIEW_DATABASE_URL_SECRET: 'ADEA_PREVIEW_DATABASE_URL',
  ADEA_PREVIEW_AUTH_BASE_URL_SECRET: 'ADEA_PREVIEW_AUTH_BASE_URL',
  ADEA_PREVIEW_AUTH_COOKIE_SECRET_NAME: 'ADEA_PREVIEW_AUTH_COOKIE_SECRET',
  ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS_SECRET: 'ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS',
}

// A Preview Worker runs unreviewed pull-request code. These pin that a Preview
// build never emits a production data or credential binding on its own, and
// that the production build is exactly what it was.
describe('cloudflare.config.ts preview isolation', () => {
  test('a production build keeps the full production binding set', () => {
    const production = evaluate({ isPreview: false, mode: undefined }).worker.env
    expect(Object.keys(production).toSorted()).toEqual([
      'ASSETS',
      'AUTH_TRUSTED_ORIGINS',
      'CONTROL_PLANE_ORIGIN',
      'CONTROL_PLANE_SIGNING_ISSUER',
      'CONTROL_PLANE_SIGNING_KEY',
      'CONTROL_PLANE_SIGNING_KEY_ID',
      'DATABASE_URL',
      'HYPERDRIVE',
      'NEON_AUTH_BASE_URL',
      'NEON_AUTH_COOKIE_SECRET',
    ])
    expect(production.HYPERDRIVE).toEqual({ type: 'hyperdrive', id: productionHyperdriveId })
    expect(production.DATABASE_URL).toMatchObject({
      type: 'secrets-store-secret',
      secretName: 'AGENT_HQ_NEON_PRODUCTION_DATABASE_URL',
    })
  })

  test('a preview build with no isolated resources is blocked, not deployed as assets only', () => {
    for (const context of [
      { isPreview: true, mode: 'preview' },
      { isPreview: true, mode: undefined },
      { isPreview: true, mode: 'production' },
      // A preview mode without the preview flag is still a preview.
      { isPreview: false, mode: 'preview' },
    ]) {
      expect(() => evaluate(context)).toThrow('Preview deployment blocked')
    }
    // The message names what to select and never a production resource.
    let message = ''
    try {
      previewEnv({})
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('ADEA_PREVIEW_HYPERDRIVE_ID')
    expect(message).not.toContain(productionHyperdriveId)
    expect(message).not.toContain(productionStoreId)
    // Blank values are no selection either.
    expect(() => previewEnv({ ADEA_PREVIEW_HYPERDRIVE_ID: '  ' })).toThrow('blocked')
  })

  test('a preview build never emits a production binding, with or without a selection', () => {
    const env = previewEnv(selection) as unknown as Resolved['worker']['env']
    const text = JSON.stringify(env)
    for (const forbidden of [productionHyperdriveId, productionStoreId, 'PRODUCTION', 'railway']) {
      expect(text).not.toContain(forbidden)
    }
    expect(Object.keys(env)).not.toContain('CONTROL_PLANE_SIGNING_KEY')
    expect(Object.keys(env)).not.toContain('CONTROL_PLANE_ORIGIN')
  })

  test('a preview with an explicit preview selection gets exactly those bindings', () => {
    const env = previewEnv(selection) as unknown as Resolved['worker']['env']
    expect(Object.keys(env).toSorted()).toEqual([
      'ASSETS',
      'AUTH_TRUSTED_ORIGINS',
      'DATABASE_URL',
      'HYPERDRIVE',
      'NEON_AUTH_BASE_URL',
      'NEON_AUTH_COOKIE_SECRET',
    ])
    expect(env.HYPERDRIVE).toEqual({ type: 'hyperdrive', id: selection.ADEA_PREVIEW_HYPERDRIVE_ID })
    expect(env.DATABASE_URL).toEqual({
      type: 'secrets-store-secret',
      storeId: selection.ADEA_PREVIEW_SECRETS_STORE_ID,
      secretName: 'ADEA_PREVIEW_DATABASE_URL',
    })
    const text = JSON.stringify(env)
    expect(text).not.toContain(productionHyperdriveId)
    expect(text).not.toContain(productionStoreId)
  })

  test('a partial preview selection fails the build closed', () => {
    for (const omitted of Object.keys(selection)) {
      const partial: Record<string, string | undefined> = { ...selection, [omitted]: undefined }
      expect(() => previewEnv(partial)).toThrow('all or nothing')
      expect(() => previewEnv({ ...partial, [omitted]: '  ' })).toThrow('all or nothing')
    }
  })

  test('a preview selection naming a production resource fails the build closed', () => {
    expect(() =>
      previewEnv({ ...selection, ADEA_PREVIEW_HYPERDRIVE_ID: productionHyperdriveId })
    ).toThrow('production Hyperdrive')
    expect(() =>
      previewEnv({ ...selection, ADEA_PREVIEW_SECRETS_STORE_ID: productionStoreId })
    ).toThrow('production Hyperdrive or Secrets Store')
    for (const key of [
      'ADEA_PREVIEW_DATABASE_URL_SECRET',
      'ADEA_PREVIEW_AUTH_BASE_URL_SECRET',
      'ADEA_PREVIEW_AUTH_COOKIE_SECRET_NAME',
      'ADEA_PREVIEW_AUTH_TRUSTED_ORIGINS_SECRET',
    ]) {
      for (const name of [
        'AGENT_HQ_NEON_PRODUCTION_DATABASE_URL',
        'AGENT_HQ_WORKER_AUTH_COOKIE_SECRET',
        'ADEA_CONTROL_PLANE_SIGNING_KEY',
        'SOME_OTHER_SECRET',
      ]) {
        expect(() => previewEnv({ ...selection, [key]: name })).toThrow('dedicated preview secret')
      }
    }
  })

  test('the selection is read from the build environment, not baked in', () => {
    const keys = Object.keys(selection)
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    try {
      for (const key of keys) delete process.env[key]
      expect(() => evaluate({ isPreview: true, mode: 'preview' })).toThrow('blocked')
      Object.assign(process.env, selection)
      const env = evaluate({ isPreview: true, mode: 'preview' }).worker.env
      expect(env.HYPERDRIVE).toEqual({
        type: 'hyperdrive',
        id: selection.ADEA_PREVIEW_HYPERDRIVE_ID,
      })
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
  })

  test('the preview workflow passes no build variables, so its preview is blocked as it stands', async () => {
    // cloudflare-deploy.yml@v1 builds with the environment it sets itself; the
    // caller supplies no ADEA_PREVIEW_* selection. Until it does, the Preview
    // job fails at the build with the message above instead of publishing a
    // Worker that cannot serve its API.
    const workflow = await Bun.file(
      new URL('../../../.github/workflows/cloudflare-preview.yml', import.meta.url)
    ).text()
    expect(workflow).not.toContain('ADEA_PREVIEW_')
    expect(workflow).toContain('mode: preview')
  })
})
