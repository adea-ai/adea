import type { AgentHqDatabase, AgentHqTransaction } from "./connection";
import { workspaceEvents } from "./schema";

export function inTransaction<T>(
  database: AgentHqDatabase,
  operation: (transaction: AgentHqTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(operation);
}

export async function appendWorkspaceEvent(
  transaction: AgentHqTransaction,
  event: typeof workspaceEvents.$inferInsert
): Promise<void> {
  await transaction.insert(workspaceEvents).values(event);
}
