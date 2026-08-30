import { QueryClient } from "@tanstack/react-query";

export const projectQueryKeys = {
  root: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  revisions: (projectId: string) => ["projects", "revisions", projectId] as const,
  layouts: (projectId: string) => ["projects", "layouts", projectId] as const,
  layout: (projectId: string, viewKey: string) =>
    ["projects", "layouts", projectId, viewKey] as const,
};

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1 },
      mutations: { retry: false },
    },
  });
}
