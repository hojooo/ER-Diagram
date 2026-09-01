import { z } from "./zod.js";

export const healthLiveResponseSchema = z.object({ status: z.literal("ok") }).strict();
export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

export const healthReadyResponseSchema = z.object({ status: z.literal("ready") }).strict();
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;
