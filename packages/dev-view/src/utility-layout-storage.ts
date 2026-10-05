/**
 * Keep scoped layout persistence outside the shared shell's startup chunk.
 * The module contains document validation and migration and is needed only
 * after a canonical Dev/Chat session binds the utility owner.
 */
export type LayoutStorageModule = typeof import('./layout/storage')
export type LayoutStorageModuleLoader = () => Promise<LayoutStorageModule>

export const loadLayoutStorageModule: LayoutStorageModuleLoader = () => import('./layout/storage')
