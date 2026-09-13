export interface WorkspaceBrandProps {
  title: string
  eyebrow?: string
}

export function WorkspaceBrand(props: WorkspaceBrandProps) {
  return (
    <div class="workspace-brand">
      <div class="workspace-brand__mark" aria-hidden="true">
        <span>HQ</span>
      </div>
      <div>
        <p class="workspace-eyebrow">{props.eyebrow ?? 'AGENT OPERATIONS'}</p>
        <h1>{props.title}</h1>
      </div>
    </div>
  )
}
