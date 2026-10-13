// Device-wide default harness (Andrew, 2026-10-13): one harness FAMILY chosen
// once per device so a new workspace needs no reconfiguring. A workspace's own
// stored default (preferences.ts) overrides it.
//
// The record names a family, never an installation id: installation ids are
// bound to one workspace scope, a family is not. The store is deliberately not
// scope-filtered; the data directory already belongs to this device.
import { join } from 'node:path'

import { createDurableJsonStore } from '../host-store'

const DEVICE_DEFAULT_STORE_FILE = join('dev-runtime', 'harness', 'device-default.json')

type DeviceDefaultRecord = Readonly<{ family?: string; version: number }>

export type HarnessDeviceDefaultState = Readonly<{ family?: string; version: number }>

export type HarnessDeviceDefaultAuthority = Readonly<{
  read(): HarnessDeviceDefaultState
  /** Sets (or, with no family, clears) the default. Returns the new state. */
  write(family: string | undefined): HarnessDeviceDefaultState
}>

export function createHarnessDeviceDefaultAuthority(input: {
  dataDir: string
}): HarnessDeviceDefaultAuthority {
  const store = createDurableJsonStore<DeviceDefaultRecord>({
    file: join(input.dataDir, DEVICE_DEFAULT_STORE_FILE),
    schemaVersion: 1,
    label: 'harness device default',
  })

  function read(): HarnessDeviceDefaultState {
    const record = store.load().records[0]
    return record
      ? {
          ...(record.family !== undefined ? { family: record.family } : {}),
          version: record.version,
        }
      : { version: 0 }
  }

  return {
    read,
    write(family) {
      const next: DeviceDefaultRecord = {
        ...(family !== undefined ? { family } : {}),
        version: read().version + 1,
      }
      store.save([next])
      return next
    },
  }
}
