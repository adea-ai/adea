"use client";

import { useWorkspaceStore } from "@agent-hq/state";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Releases every cached query and in-flight request belonging to one workspace.
 * Workspaces are fully isolated contexts, so leaving one must drop its data
 * instead of keeping it resident until the garbage-collection window closes.
 * User-scoped entries (bootstrap, workspace list) live outside this key and
 * survive the release.
 */
export function releaseWorkspaceCache(queryClient: QueryClient, workspaceId: string) {
  if (!workspaceId) return;
  void queryClient.cancelQueries({ queryKey: ["workspaces", workspaceId] });
  queryClient.removeQueries({ queryKey: ["workspaces", workspaceId] });
}

export function AgentHqQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const previousWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const previousWorkspaceId = previousWorkspaceIdRef.current;
    previousWorkspaceIdRef.current = selectedWorkspaceId;
    if (previousWorkspaceId && selectedWorkspaceId && previousWorkspaceId !== selectedWorkspaceId)
      releaseWorkspaceCache(queryClient, previousWorkspaceId);
  }, [queryClient, selectedWorkspaceId]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
