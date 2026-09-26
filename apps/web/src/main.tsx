import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";

import App from "./App";
import { ApiError } from "./lib/api";
import ScoreDetailPage from "./pages/ScoreDetailPage";
import ScoresPage from "./pages/ScoresPage";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching a score list because the user tabbed back to the window is noise;
      // nothing here changes without this client doing something.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (count, error) => error instanceof ApiError && error.isRetryable && count < 2,
    },
  },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <ScoresPage /> },
      { path: "scores/:scoreId", element: <ScoreDetailPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
