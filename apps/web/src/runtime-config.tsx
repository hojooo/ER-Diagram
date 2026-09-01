import type { RuntimeConfigResponse, RuntimeResourceLimits } from "@er-diagram/contracts";
import { createContext, type ReactNode, useContext } from "react";

const RuntimeConfigContext = createContext<RuntimeConfigResponse | null>(null);

export function RuntimeConfigProvider({
  config,
  children,
}: {
  readonly config: RuntimeConfigResponse;
  readonly children: ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfigResponse {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error("Runtime config is unavailable before application startup.");
  return config;
}

export function useRuntimeResourceLimits(): RuntimeResourceLimits {
  return useRuntimeConfig().resourceLimits;
}
