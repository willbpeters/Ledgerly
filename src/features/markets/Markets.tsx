import { useEffect, useRef } from "react";
import { PageHeader, Card, Button, Badge, EmptyState } from "../../ui/components";
import { money, pct, timeAgo } from "../../ui/format";
import { useMarketRefresh } from "../../data/queries";
import { useRefreshPrices } from "../../data/useRefresh";
import { planNextMarketTick } from "../../data/marketSchedule";
import { useMarketView } from "./useMarketView";
import { TodayBoard } from "./TodayBoard";
import { SectorHeatmap } from "./SectorHeatmap";
import { HoldingsHeatmap } from "./HoldingsHeatmap";
import type { MarketRow } from "../../domain/market";

// `pct` already supplies its own +/- sign, so do not add another.
// `.pos` and `.neg` are existing classes in styles.css.
function Move({ value }: { value: number }) {
  const tone = value > 0 ? "pos" : value < 0 ? "neg" : undefined;
  return <span className={tone}>{pct(value)}</span>;
}

function CompanyRow({ r }: { r: MarketRow }) {
  return (
    <div className="market-row">
      <div className="market-row-head">
        <span className="cell-primary">{r.ticker}</span>
        <Move value={r.dayChangePct} />
        {r.nextEarnings && <Badge tone="accent">Reports {r.nextEarnings.report_date}</Badge>}
        {r.lastEarnings?.beat !== undefined && (
          <Badge tone={r.lastEarnings.beat ? "pos" : "neg"}>
            {r.lastEarnings.beat ? "Beat" : "Missed"} last quarter
          </Badge>
        )}
        <span className="cell-secondary">{r.name ?? ""}</span>
        <span className="cell-secondary">{money(r.value)}</span>
      </div>
      {r.news.length === 0
        ? <div className="cell-secondary">No headlines today.</div>
        : r.news.map((n) => (
            <div key={n.url} className="cell-secondary">
              <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
              {" — "}{n.publisher ?? "unknown"} · {timeAgo(n.published)}
            </div>
          ))}
    </div>
  );
}

export function Markets() {
  const { view, you } = useMarketView();
  const refresh = useMarketRefresh();
  const prices = useRefreshPrices();
  // One button for everything Markets shows: headlines and your prices.
  const refreshAll = () => { refresh.mutate(); prices.mutate(); };

  // A slow poll while the screen is open. The cadence is decided by a pure
  // function so it is unit-tested; this effect only obeys it. Nothing fetches
  // while the window is hidden, and a warm cache is left alone.
  const busy = useRef(false);
  const latest = useRef({ refresh, newestFetch: view.newestFetch });
  latest.current = { refresh, newestFetch: view.newestFetch };
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const plan = planNextMarketTick(new Date(), !document.hidden, latest.current.newestFetch);
      if (plan.fetch && !busy.current) {
        busy.current = true;
        latest.current.refresh.mutate(undefined, { onSettled: () => { busy.current = false; } });
      }
      timer = window.setTimeout(tick, plan.delayMs);
    };
    timer = window.setTimeout(tick, 1000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <>
      <PageHeader subtitle="The market today, and what happened to what you own" />

      <TodayBoard rows={view.indices} you={you}
        actions={<Button size="sm" loading={refresh.isPending || prices.isPending} onClick={refreshAll}>Refresh</Button>}
        footer={<>
          {view.newestFetch
            ? <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                News as of {timeAgo(view.newestFetch)}.
              </p>
            : <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                Nothing fetched yet — press Refresh.
              </p>}
          <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
            {prices.isSuccess ? `Updated ${prices.data} prices. ` : ""}
            Prices also refresh on their own: every few seconds during US market hours, every 15 minutes otherwise.
          </p>
          {prices.isError && (
            <div className="notice neg" style={{ marginTop: 8 }}>
              Couldn't refresh prices. Check your connection and try again.
            </div>
          )}
          {refresh.data && refresh.data.errors.length > 0 && (
            <div className="notice warn" style={{ marginTop: 8 }}>
              {refresh.data.errors.length} source{refresh.data.errors.length === 1 ? "" : "s"} could
              not be reached. What was already stored is still shown.
            </div>
          )}
        </>} />

      <div className="grid grid-2">
        <SectorHeatmap sectors={view.sectors} />
        <HoldingsHeatmap holdings={view.companies.map((r) => (
          { ticker: r.ticker, value: r.value, changePct: r.dayChangePct }
        ))} />
      </div>

      <Card title="Your companies" subtitle="Biggest movers first. Headlines sit beside moves, not as their cause.">
        {view.companies.length === 0
          ? <EmptyState title="No companies held"
              body="Individual stocks appear here once you hold them. Press Refresh to fetch headlines." />
          : view.companies.map((r) => <CompanyRow key={r.security_id} r={r} />)}
      </Card>

      <Card title="Your funds" subtitle="Index funds have no company news — what they track is the story.">
        {view.funds.length === 0
          ? <EmptyState title="No funds held" body="Index funds and ETFs appear here." />
          : view.funds.map((r) => (
              <div key={r.security_id} className="market-row-head" style={{ padding: "8px 0" }}>
                <span className="cell-primary">{r.ticker}</span>
                <span className="cell-secondary">{r.tracks ?? r.name ?? ""}</span>
                <Move value={r.dayChangePct} />
                <span className="cell-secondary">{money(r.value)}</span>
              </div>
            ))}
      </Card>

      <Card title="Earnings — next 14 days">
        {view.calendar.length === 0
          ? <p className="muted">Nothing you hold reports in the next two weeks.</p>
          : <div className="row center" style={{ gap: 12, flexWrap: "wrap" }}>
              {view.calendar.map((d) => (
                <div key={d.date} className="market-day">
                  <div className="cell-secondary">{d.date}</div>
                  <div className="cell-primary">{d.tickers.join(", ")}</div>
                </div>
              ))}
            </div>}
      </Card>
    </>
  );
}
