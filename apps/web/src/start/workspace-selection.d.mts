export function workspaceSelection(params: Record<string, string | string[]>): {
  virtual: boolean
  roomDesigner: boolean
  characterDesigner: boolean
  character: string | undefined
  cameraViewMode: 'perspective' | 'orthographic' | undefined
}
