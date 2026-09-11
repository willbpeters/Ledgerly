import { useMemo } from "react";
import {
  useSecurities, useMarketNews, useMarketEarnings, useMarketProfiles,
  useMarketIndices, useLatestPrices, usePreviousPrices,
} from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { buildMarketView } from "../../domain/market";

/**
 * Everything the Markets screen needs, assembled by the pure
 * `buildMarketView`.
 *
 * `Holding` carries no per-security day change — only the portfolio summary
 * has one — so it is derived here from the same latest and previous closes the
 * Dashboard's day-change figure uses. Market values come from `usePortfolio`,
 * so the two screens cannot disagree about what is held.
 */
export function useMarketView() {
  const { data: securities = [] } = useSecurities();
  const { data: news = [] } = useMarketNews();
  const { data: earnings = [] } = useMarketEarnings();
  const { data: profiles = [] } = useMarketProfiles();
  const { data: indices = [] } = useMarketIndices();
  const { data: latest = [] } = useLatestPrices();
  const { data: previous = [] } = usePreviousPrices();
  const { holdings, summary } = usePortfolio();

  return useMemo(() => {
    const latestMap = new Map<number, number>(latest);
    const prevMap = new Map<number, number>(previous);

    const value = new Map<number, number>();
    const dayChange = new Map<number, number>();
    for (const h of holdings) {
      value.set(h.security_id, h.marketValue);
      const now = latestMap.get(h.security_id);
      const before = prevMap.get(h.security_id);
      // No previous close means we cannot know today's move. Zero is the
      // honest answer; a made-up percentage is not.
      dayChange.set(
        h.security_id,
        now != null && before != null && before !== 0 ? ((now - before) / before) * 100 : 0,
      );
    }

    const view = buildMarketView({
      securities, profiles, news, earnings, indices,
      holdings: value, dayChange,
      today: new Date().toISOString().slice(0, 10),
    });
    return { view, you: summary.dayChangePct };
  }, [securities, profiles, news, earnings, indices, latest, previous, holdings, summary]);
}
