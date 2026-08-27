import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router-dom";
import { App, createAppRoutes } from "./App.js";
import { createHttpProjectApi } from "./projects/project-api.js";
import { createAppQueryClient } from "./projects/project-queries.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

const api = createHttpProjectApi();
const queryClient = createAppQueryClient();
const router = createBrowserRouter(
  // The layout spike is a development-only regression harness and is excluded from production routes.
  createAppRoutes({ includeLayoutSpike: import.meta.env.DEV }),
);

createRoot(root).render(
  <StrictMode>
    <App api={api} queryClient={queryClient} router={router} />
  </StrictMode>,
);
