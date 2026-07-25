import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Job status changes out from under the user, so a refetch on focus is
      // the cheap way to stay honest without polling.
      refetchOnWindowFocus: true,
      staleTime: 10_000,
      retry: 1,
    },
    mutations: { retry: 0 },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
