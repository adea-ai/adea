import { fileURLToPath } from 'node:url'
import { mergeConfig, type ConfigEnv, type UserConfig } from 'vite'
import baseConfig from './vite.config'

// The auth fixture build: the ordinary app configuration with one module replaced by
// a loopback recording transport. Only this file selects that module. The output
// goes to its own directory, which the production build never reads or writes, and
// nothing reads an environment variable to switch this on.
const fixtureOutDir = fileURLToPath(new URL('./start/.checks/auth-fixture/dist', import.meta.url))
const fixtureTransport = fileURLToPath(
  new URL('./test-fixtures/auth-message-transport.fixture.ts', import.meta.url)
)

export default (environment: ConfigEnv): UserConfig =>
  mergeConfig(baseConfig(environment) as UserConfig, {
    build: { outDir: fixtureOutDir },
    resolve: {
      alias: [{ find: /^\.\/auth-message-transport$/, replacement: fixtureTransport }],
    },
  })
