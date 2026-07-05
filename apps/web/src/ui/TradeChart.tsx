// TradingView Lightweight Charts wrapper for the Trade screen's market
// detail: candlestick series + volume histogram fed by BookState candles.
//
// Live-update contract: the chart is created once per mount; series data is
// replaced (setData + fit) only when `resetKey` changes — i.e. the caller
// switched (venue, asset, timeframe) — or on the first snapshot. Subsequent
// BookState pushes only `update()` the newest bar(s), which keeps the user's
// scroll/zoom position intact between trades.

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CandleMsg } from "../net/protocol";
import "./tradechart.css";

const UP = "#7be0c2";
const DOWN = "#ff6a7c";
const UP_DIM = "rgba(123, 224, 194, 0.45)";
const DOWN_DIM = "rgba(255, 106, 124, 0.45)";
const TEXT_DIM = "#7f8ea0";
const GRID_LINE = "rgba(159, 180, 200, 0.10)";
const SCALE_BORDER = "rgba(159, 180, 200, 0.22)";

function toBar(c: CandleMsg): CandlestickData<UTCTimestamp> {
  return {
    time: (c.t / 1000) as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function toVolume(c: CandleMsg): HistogramData<UTCTimestamp> {
  return {
    time: (c.t / 1000) as UTCTimestamp,
    value: c.volume_wild,
    color: c.close >= c.open ? UP_DIM : DOWN_DIM,
  };
}

/**
 * Candles + volume for one (venue, asset) at one timeframe. `resetKey` must
 * change whenever the caller swaps market or timeframe so the chart reloads
 * instead of live-patching across datasets. `candles === null` means "the
 * new subscription hasn't answered yet": the chart keeps showing the
 * previous dataset instead of flashing empty.
 */
export function TradeChart({
  candles,
  tfSecs,
  resetKey,
}: {
  candles: CandleMsg[] | null;
  tfSecs: number;
  resetKey: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** resetKey of the dataset currently loaded via setData. */
  const loadedKeyRef = useRef<string | null>(null);
  /** Bucket time (ms) of the newest bar the chart holds. */
  const lastBarMsRef = useRef<number | null>(null);

  // Chart lifecycle: create once, resize with the container, destroy on
  // unmount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: false,
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: TEXT_DIM,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID_LINE },
        horzLines: { color: GRID_LINE },
      },
      rightPriceScale: { borderColor: SCALE_BORDER },
      timeScale: {
        borderColor: SCALE_BORDER,
        timeVisible: true,
      },
      crosshair: {
        vertLine: { color: "rgba(234, 247, 255, 0.35)", labelBackgroundColor: "#22303f" },
        horzLine: { color: "rgba(234, 247, 255, 0.35)", labelBackgroundColor: "#22303f" },
      },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    price.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    // Volume rides an overlay scale pinned to the bottom fifth.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    priceRef.current = price;
    volumeRef.current = volume;
    loadedKeyRef.current = null;
    lastBarMsRef.current = null;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        chart.applyOptions({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  // Sub-minute frames need seconds on the time axis.
  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: tfSecs < 60 } });
  }, [tfSecs]);

  // Data feed: full reload on market/timeframe switch, incremental
  // series.update() for live pushes on the same subscription.
  useEffect(() => {
    const price = priceRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!price || !volume || !chart || candles === null) return;

    const lastMs = lastBarMsRef.current;
    const fresh = loadedKeyRef.current !== resetKey || lastMs === null;
    if (fresh || candles.length === 0) {
      price.setData(candles.map(toBar));
      volume.setData(candles.map(toVolume));
      chart.timeScale().fitContent();
      loadedKeyRef.current = resetKey;
      lastBarMsRef.current = candles.length > 0 ? candles[candles.length - 1].t : null;
      return;
    }
    // Same subscription: patch the newest bar plus any buckets that opened
    // since (BookState pushes are throttled, so several 1s buckets can land
    // in one message).
    for (const c of candles) {
      if (c.t < lastMs) continue;
      price.update(toBar(c));
      volume.update(toVolume(c));
    }
    lastBarMsRef.current = candles[candles.length - 1].t;
  }, [candles, resetKey]);

  return (
    <div className="trade-chart-wrap">
      <div ref={containerRef} className="trade-chart-canvas" />
      {candles !== null && candles.length === 0 && (
        <div className="econ-empty trade-chart-empty">No trades at this venue yet.</div>
      )}
    </div>
  );
}
