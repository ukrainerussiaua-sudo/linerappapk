import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  getCoverElement,
  preloadCoverArt,
} from "@/features/covers/lib/coverArt";
import { measureImageTone, pickStrikingIndex } from "@/shared/lib/imageTone";
import {
  readScreenCache,
  subscribeScreenCache,
  writeScreenCache,
} from "@/shared/cache/screenCache";
import {
  buildAccentBackdropSvg,
  svgToDataUrl,
} from "@/features/library/lib/likesCoverPalette";
import { extractColorsFromImage } from "../lib/extractFluidColors";
import { useSessionOwner } from "./sessionAwareLoad";
import type { DailyMix } from "./useDailyMixes";

interface HomeBackdropRecord {
  mixKey: string;
  cover: string;
  backdrop: string;
}

function loadedCover(url: string): HTMLImageElement | undefined {
  const element = getCoverElement(url);
  if (!element || !element.complete || element.naturalWidth === 0)
    return undefined;
  return element;
}

export function useHomeBackdrop(mixes: DailyMix[]): {
  cover?: string;
  backdrop?: string;
} {
  const owner = useSessionOwner();
  const key = `home:backdrop:${owner}`;
  const candidates = mixes
    .slice(0, 4)
    .map((mix) => mix.coverUrl)
    .filter((url): url is string => Boolean(url));
  const mixKey = candidates.join("|");

  const subscribe = useCallback(
    (listener: () => void) => subscribeScreenCache(key, listener),
    [key],
  );
  const record = useSyncExternalStore(
    subscribe,
    () => readScreenCache<HomeBackdropRecord>(key)?.data,
  );
  const recordMixKey = record?.mixKey;

  useEffect(() => {
    if (!mixKey || recordMixKey === mixKey) return;
    const urls = mixKey.split("|");
    let active = true;
    void Promise.all(
      urls.map((url) => preloadCoverArt(url).catch(() => undefined)),
    ).then(() => {
      if (!active) return;
      const tones = urls.map((url) => {
        const element = loadedCover(url);
        return element ? measureImageTone(element) : undefined;
      });
      const cover = urls[pickStrikingIndex(tones)];
      const element = cover ? loadedCover(cover) : undefined;
      if (!cover || !element) return;
      const backdrop = svgToDataUrl(
        buildAccentBackdropSvg(extractColorsFromImage(element)),
      );
      writeScreenCache<HomeBackdropRecord>(key, { mixKey, cover, backdrop });
    });
    return () => {
      active = false;
    };
  }, [key, mixKey, recordMixKey]);

  return {
    cover: record && record.mixKey === mixKey ? record.cover : candidates[0],
    backdrop: record?.backdrop,
  };
}
