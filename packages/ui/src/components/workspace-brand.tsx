export interface WorkspaceBrandProps {
  title: string;
  eyebrow?: string;
}

export function WorkspaceBrand({ title, eyebrow = "AGENT OPERATIONS" }: WorkspaceBrandProps) {
  return (
    <div className="workspace-brand">
      <div className="workspace-brand__mark" aria-hidden="true">
        <span>HQ</span>
      </div>
      <div>
        <p className="workspace-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
    </div>
  );
}
