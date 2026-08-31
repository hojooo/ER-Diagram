import { z } from "zod";

// Zod's object-schema fast path probes the Function constructor unless jitless mode is enabled.
// Configure it before any shared contract module constructs a schema so Web validation remains
// compatible with the production CSP (`script-src 'self'`).
z.config({ jitless: true });

export { z };
