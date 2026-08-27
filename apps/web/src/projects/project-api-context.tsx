import { createContext, type ReactNode, useContext } from "react";

import type { ProjectApi } from "./project-api.js";

const ProjectApiContext = createContext<ProjectApi | null>(null);

export function ProjectApiProvider({
  api,
  children,
}: {
  readonly api: ProjectApi;
  readonly children: ReactNode;
}) {
  return <ProjectApiContext.Provider value={api}>{children}</ProjectApiContext.Provider>;
}

export function useProjectApi(): ProjectApi {
  const api = useContext(ProjectApiContext);
  if (!api) throw new Error("ProjectApiProvider is required.");
  return api;
}
