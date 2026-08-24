import { index, text } from "drizzle-orm/pg-core";

import { appSchema } from "./schema";
import { entityId, softDeleteColumns, timestampColumns } from "./conventions";

export const workspaces = appSchema.table(
  "workspaces",
  {
    id: entityId(),
    name: text("name").notNull(),
    ...timestampColumns(),
    ...softDeleteColumns(),
  },
  (table) => [index("workspaces_active_idx").on(table.deletedAt)],
);
