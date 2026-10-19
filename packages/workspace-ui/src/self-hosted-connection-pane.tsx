// The self-hosted pane with every operation's code attached (#188): pairing, rename and revoke.
// A view that connects none of them mounts the core pane instead, which renders those controls as
// unavailable and leaves this code out of its bundle.
import { HostActions } from './self-hosted-host-actions'
import SelfHostedConnectionPaneCore, {
  type SelfHostedConnectionPaneCoreProps,
} from './self-hosted-connection-pane-core'
import { SelfHostedSetupGuide } from './self-hosted-setup-guide'

export type SelfHostedConnectionPaneProps = Omit<SelfHostedConnectionPaneCoreProps, 'slots'>

const SLOTS = { HostActions, SetupGuide: SelfHostedSetupGuide } as const

export default function SelfHostedConnectionPane(props: SelfHostedConnectionPaneProps) {
  return <SelfHostedConnectionPaneCore {...props} slots={SLOTS} />
}
