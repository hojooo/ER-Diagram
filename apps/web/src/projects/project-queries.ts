import { QueryClient } from "@tanstack/react-query";

export const projectQueryKeys = {
  root: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
};

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1 },
      mutations: { retry: false },
    },
  });
}
