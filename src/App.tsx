import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { usePriceAutoRefresh } from "./data/usePriceAutoRefresh";
import { usePriceHistory } from "./data/priceHistory";
import { AppShell } from "./app/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Holdings } from "./features/holdings/Holdings";
import { Markets } from "./features/markets/Markets";
import { Accounts } from "./features/accounts/Accounts";
import { Activity } from "./features/activity/Activity";
import { Settings } from "./features/settings/Settings";
import { Spending } from "./features/spending/Spending";
import { ThemeProvider } from "./ui/theme";
import { ToastProvider } from "./ui/toast";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  {
    path: "/", element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "holdings", element: <Holdings /> },
      { path: "markets", element: <Markets /> },
      { path: "accounts", element: <Accounts /> },
      { path: "activity", element: <Activity /> },
      { path: "spending", element: <Spending /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

function AutoRefresh() {
  usePriceAutoRefresh();
  // Fills in two years of daily closes once, so the risk figures have
  // something to work from.
  usePriceHistory();
  return null;
}

export default function App() {
  return (
    // Outermost net: catches anything the per-screen boundary in AppShell can't,
    // so the packaged app never shows a blank white window.
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <AutoRefresh />
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
