import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { usePriceAutoRefresh } from "./data/usePriceAutoRefresh";
import { AppShell } from "./app/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Holdings } from "./features/holdings/Holdings";
import { Accounts } from "./features/accounts/Accounts";
import { Activity } from "./features/activity/Activity";
import { Settings } from "./features/settings/Settings";
import { ThemeProvider } from "./ui/theme";
import { ToastProvider } from "./ui/toast";
import "./styles.css";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  {
    path: "/", element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "holdings", element: <Holdings /> },
      { path: "accounts", element: <Accounts /> },
      { path: "activity", element: <Activity /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

function AutoRefresh() {
  usePriceAutoRefresh();
  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <AutoRefresh />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
