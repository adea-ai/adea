import { expect, test } from 'bun:test'
import { parseSimHostContract } from '../src/lib/sim-host-contract'

const contract = {
  assetPrefix: '/private/sim/',
  entryFiles: {
    hq: 'engine-1.js',
    'room-designer': 'room-designer2.js',
    'character-designer': 'character-designer3.js',
  },
}

test('the browser accepts a complete contract with digits and returns it frozen', () => {
  const parsed = parseSimHostContract(contract)
  expect(parsed).toEqual(contract)
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed!.entryFiles)).toBe(true)
})

test('a missing, partial or malformed contract fails closed instead of falling back', () => {
  expect(parseSimHostContract(undefined)).toBeNull()
  expect(parseSimHostContract({})).toBeNull()
  expect(parseSimHostContract({ ...contract, assetPrefix: undefined })).toBeNull()
  for (const prefix of ['/', 'assets/', '/a/../', '//evil.example/', '/Assets/', '/a b/'])
    expect(parseSimHostContract({ ...contract, assetPrefix: prefix })).toBeNull()
  for (const file of ['../x.js', 'room.css', 'Room.js', '', 'a/b.js'])
    expect(
      parseSimHostContract({ ...contract, entryFiles: { ...contract.entryFiles, hq: file } })
    ).toBeNull()
  const { hq: _hq, ...missingHq } = contract.entryFiles
  expect(parseSimHostContract({ ...contract, entryFiles: missingHq })).toBeNull()
  expect(
    parseSimHostContract({
      ...contract,
      entryFiles: { ...contract.entryFiles, 'room-designer': 'engine-1.js' },
    })
  ).toBeNull()
})
