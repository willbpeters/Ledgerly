import { useMemo } from "react";
import { localIsoDate } from "../../domain/dates";
import { usePortfolio } from "../../data/usePortfolio";
import { useBankTransactions, useSecurities, useTransactions } from "../../data/queries";
import { useValueSeries } from "../../data/useValueSeries";
import { accountOverview, activityWindowStart, recentActivity } from "../../domain/overview";
import { ValueCard } from "./ValueCard";
import { AccountsCard } from "./AccountsCard";
import { RecentActivityCard } from "./RecentActivityCard";

/** How far back the activity list reaches, today included. */
const ACTIVITY_DAYS = 7;

/**
 * An overview: what everything is worth over time, where it sits, and what
 * moved this week. Positions and the risk cards live on Holdings.
 */
export function Dashboard() {
  const { summary, byAccount, accounts, isLoading } = usePortfolio();
  const { series } = useValueSeries();
  const today = localIsoDate();
  const { data: bankTxns = [] } = useBankTransactions(activityWindowStart(today, ACTIVITY_DAYS), today);
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();

  const groups = useMemo(() => accountOverview(byAccount), [byAccount]);
  const activity = useMemo(
    () => recentActivity({ bankTxns, txns, accounts, securities, today, days: ACTIVITY_DAYS }),
    [bankTxns, txns, accounts, securities, today],
  );

  if (isLoading) return <p className="muted">Loading…</p>;

  return (
    <>
      <ValueCard summary={summary} series={series} />
      <AccountsCard groups={groups} />
      <RecentActivityCard rows={activity} />
    </>
  );
}
