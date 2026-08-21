"use client";

import { useQuery } from "@tanstack/react-query";

import type { AgentSummary } from "./agent-types";

async function fetchAgents(signal: AbortSignal): Promise<AgentSummary[]> {
  const response = await fetch("/api/agents", { cache: "no-store", signal });

  if (!response.ok) {
    throw new Error("Unable to load agents.");
  }

  return response.json() as Promise<AgentSummary[]>;
}

export const agentsQueryKey = ["agents"] as const;

export function useAgentsQuery() {
  return useQuery({
    gcTime: 5 * 60_000,
    queryKey: agentsQueryKey,
    queryFn: ({ signal }) => fetchAgents(signal),
    retry: 1,
    staleTime: 30_000,
  });
}
