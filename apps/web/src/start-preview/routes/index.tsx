import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import lazyComponent from '../lazy-component'

function Loading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  )
}

const WorkspacePreview = lazyComponent(
  () => import('../workspace-preview').then((module) => module.default),
  { loading: Loading, ssr: false }
)

export const Route = createFileRoute('/')({ component: WorkspaceRoute })

function WorkspaceRoute() {
  return (
    <ClientOnly fallback={<Loading />}>
      <WorkspacePreview />
    </ClientOnly>
  )
}
