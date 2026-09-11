/** @param {string | string[] | undefined} value */
const first = (value) => (Array.isArray(value) ? value[0] : value)

/**
 * @param {Record<string, string | string[]>} params
 * @returns {{virtual: boolean, roomDesigner: boolean, characterDesigner: boolean, character: string | undefined, cameraViewMode: 'perspective' | 'orthographic' | undefined}}
 */
export function workspaceSelection(params) {
  const room = first(params.roomDesigner)
  const characterDesigner = first(params.characterDesigner)
  const camera = first(params.camera)
  return {
    virtual: first(params.view) === 'virtual' || (room !== undefined && room !== '0'),
    roomDesigner: room !== undefined && room !== '0',
    characterDesigner: characterDesigner !== undefined && characterDesigner !== '0',
    character: first(params.character),
    cameraViewMode: camera === 'perspective' || camera === 'orthographic' ? camera : undefined,
  }
}
