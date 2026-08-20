"use client";

import { useQuery } from "@tanstack/react-query";

import type { AgentSummary } from "./agent-types";

async function fetchAgents(): Promise<AgentSummary[]> {
  const response = await fetch("/api/agents", { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Unable to load agents.");
  }

  return response.json() as Promise<AgentSummary[]>;
}

export function useAgentsQuery() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    staleTime: 30_000,
  });
}
