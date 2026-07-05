// WILD/USD spot price from the public CoinGecko API. In-game prices are WILD
// (displayed as MILD); the Trade screen multiplies by this rate to show USD
// equivalents, CMC-style. Cached in localStorage so rate limits / offline
// sessions degrade to the last known price instead of flapping to "no USD".

import { useEffect, useState } from "react";

const API_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=wilder-world&vs_currencies=usd";
const CACHE_KEY = "wilder.trade.wildusd";
/** Refresh cadence — CoinGecko's free tier is comfortable at 5 min. */
const REFRESH_MS = 5 * 60 * 1000;

interface CachedRate {
  usd: number;
  at: number;
}

function readCache(): CachedRate | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CachedRate | null;
    return raw && typeof raw.usd === "number" && raw.usd > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeCache(usd: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ usd, at: Date.now() } satisfies CachedRate));
}

/** Latest WILD/USD rate, or null while unknown (first load without cache /
 * API unreachable). Refreshes every 5 minutes while mounted. */
export function useWildUsd(): number | null {
  const [rate, setRate] = useState<number | null>(() => readCache()?.usd ?? null);

  useEffect(() => {
    let cancelled = false;

    const fetchRate = async () => {
      const cached = readCache();
      if (cached && Date.now() - cached.at < REFRESH_MS) {
        if (!cancelled) setRate(cached.usd);
        return;
      }
      try {
        const res = await fetch(API_URL);
        if (!res.ok) return;
        const body = (await res.json()) as { "wilder-world"?: { usd?: number } };
        const usd = body["wilder-world"]?.usd;
        if (typeof usd === "number" && usd > 0 && !cancelled) {
          writeCache(usd);
          setRate(usd);
        }
      } catch {
        // Offline / rate limited: keep whatever we have.
      }
    };

    void fetchRate();
    const timer = setInterval(() => void fetchRate(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return rate;
}

/** "$1,234.56", scaling decimals for sub-dollar values ("$0.0432"). */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  const abs = Math.abs(usd);
  if (abs >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (abs >= 1) {
    return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (abs >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
}
