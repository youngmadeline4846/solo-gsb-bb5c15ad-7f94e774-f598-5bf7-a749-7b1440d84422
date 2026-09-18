import type { Subtitle } from './types';
import type { WaveformData } from './waveform';

/**
 * 静音吸附：基于音频波形桶的正/负峰值找出静音段中点，
 * 把所选连续字幕区间内每条字幕的起止边界吸附到附近的静音点上。
 *
 * 静音判定：每个波形桶的 max(abs(min), abs(max)) ≤ 峰值阈值即视为静音桶；
 * 相邻静音桶合并为一段，仅保留时长 ≥ 最短静音长度的段，吸附点取段中点。
 *
 * 候选：对每条字幕的每个起止边界，候选时间包含
 *   - 原位置（距离 0，不吸附）
 *   - 距原位置 ≤ 最大吸附距离的所有静音段中点
 * 用动态规划在候选间选择方案，须保持条目顺序、每条时长 ≥ 字幕最小时长、
 * 相邻条目互不重叠（允许端点相接）；目标依次为：
 *   1. 最大化吸附边界数（边界移动到非原位置的静音中点）
 *   2. 最小化总位移（所有边界位移绝对值之和）
 *   3. 同分时取完整新时间序列字典序较小者
 */

export interface SilenceSettings {
  /** 峰值阈值（0–1）：桶峰值 max(abs(min),abs(max)) ≤ 此值判静音 */
  threshold: number;
  /** 最短静音长度（毫秒） */
  minSilenceMs: number;
  /** 最大吸附距离（毫秒） */
  maxSnapMs: number;
  /** 字幕最小时长（毫秒） */
  minDurationMs: number;
}

/** 默认参数：2% 峰值、150ms 静音、500ms 吸附、300ms 字幕时长 */
export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
  threshold: 0.02,
  minSilenceMs: 150,
  maxSnapMs: 500,
  minDurationMs: 300,
};

/** 一段连续静音，吸附点为其中点 */
export interface SilenceSegment {
  /** 段起点（毫秒） */
  start: number;
  /** 段终点（毫秒） */
  end: number;
  /** 段中点（毫秒，四舍五入），即吸附点 */
  mid: number;
}

/** 单个边界的候选时间 */
export interface BoundCandidate {
  /** 候选时间（毫秒，非负） */
  time: number;
  /** 吸附到的静音段；null 表示原位置（不吸附） */
  segment: SilenceSegment | null;
}

/** 一条字幕的吸附结果（预览 / 应用共用） */
export interface SnappedItem {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  /** 原开始时间（毫秒） */
  oldStartMs: number;
  /** 原结束时间（毫秒） */
  oldEndMs: number;
  /** 开始边界吸附到的静音段（未吸附为 null） */
  startSegment: SilenceSegment | null;
  /** 结束边界吸附到的静音段（未吸附为 null） */
  endSegment: SilenceSegment | null;
  /** 本条被吸附的边界数（0–2） */
  snapped: number;
}

export interface SilencePlan {
  /** 与所选区间同序的吸附结果 */
  items: SnappedItem[];
  /** 吸附到静音中点的边界总数 */
  snappedCount: number;
  /** 所有边界位移绝对值之和（毫秒） */
  totalShiftMs: number;
  /** 单条边界的最大位移（毫秒） */
  maxShiftMs: number;
  /** 发生变化的字幕条数 */
  changed: number;
}

/** 参数是否为可参与计算的有限正数（阈值允许 0，上限 1） */
export function validSettings(s: SilenceSettings): boolean {
  return (
    Number.isFinite(s.threshold) &&
    s.threshold >= 0 &&
    s.threshold <= 1 &&
    Number.isFinite(s.minSilenceMs) &&
    s.minSilenceMs > 0 &&
    Number.isFinite(s.maxSnapMs) &&
    s.maxSnapMs > 0 &&
    Number.isFinite(s.minDurationMs) &&
    s.minDurationMs > 0
  );
}

/**
 * 扫描波形得到全部静音段：
 * 峰值 ≤ 阈值的桶视为静音，合并相邻命中桶（连续的桶号序列），
 * 仅保留时长（桶覆盖的时间跨度）≥ 最短静音长度的段，中点四舍五入。
 */
export function findSilenceSegments(data: WaveformData, s: SilenceSettings): SilenceSegment[] {
  const { mins, maxs, bucketSec } = data;
  const bucketMs = bucketSec * 1000;
  const segments: SilenceSegment[] = [];

  let runStart = -1;
  const flush = (from: number, toExclusive: number) => {
    // 段覆盖 [from 桶起点, toExclusive 桶起点]（最后一个桶按整桶计）
    const start = from * bucketMs;
    const end = toExclusive * bucketMs;
    if (end - start >= s.minSilenceMs) {
      segments.push({ start, end, mid: Math.round((start + end) / 2) });
    }
  };

  for (let b = 0; b < mins.length; b++) {
    const peak = Math.max(Math.abs(mins[b]), Math.abs(maxs[b]));
    if (peak <= s.threshold) {
      if (runStart < 0) runStart = b;
    } else if (runStart >= 0) {
      flush(runStart, b);
      runStart = -1;
    }
  }
  if (runStart >= 0) flush(runStart, mins.length);
  return segments;
}

/** 第一个 mid ≥ target 的段下标（段中点随下标单调递增） */
function lowerBoundMid(segments: SilenceSegment[], target: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].mid < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 为一个边界生成候选时间：原位置（segment=null，优先保留）+
 * 距离内的静音段中点。同一时间去重，结果按时间升序。
 */
export function boundaryCandidates(
  originMs: number,
  segments: SilenceSegment[],
  maxSnapMs: number
): BoundCandidate[] {
  const origin = Math.max(0, Math.round(originMs));
  const byTime = new Map<number, BoundCandidate>();
  byTime.set(origin, { time: origin, segment: null });

  let i = lowerBoundMid(segments, origin - maxSnapMs);
  for (; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.mid > origin + maxSnapMs) break;
    if (seg.mid >= 0 && !byTime.has(seg.mid)) {
      byTime.set(seg.mid, { time: seg.mid, segment: seg });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * 按开始时间（相同则按原序号）排序后取 [from, to] 之间的连续区间（含两端）。
 */
export function selectRange(subs: Subtitle[], fromId: string | null, toId: string | null): Subtitle[] {
  if (!fromId || !toId) return [];
  const order = [...subs].sort((a, b) => a.start - b.start || a.index - b.index);
  const i = order.findIndex((s) => s.id === fromId);
  const j = order.findIndex((s) => s.id === toId);
  if (i === -1 || j === -1) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** DP 节点：某一边界层选择某候选时间后的最优部分方案 */
interface DpNode {
  /** 本层选中的边界时间（毫秒） */
  time: number;
  /** 吸附边界累计数 */
  snapped: number;
  /** 累计总位移（毫秒） */
  shift: number;
  /** 前驱节点在上一层（时间升序）数组中的下标 */
  prev: number;
  /** 本节点完整时间序列在同层中的字典序稠密排名（0 最小） */
  rank: number;
  /** 本边界吸附到的静音段（null = 保持原位置） */
  segment: SilenceSegment | null;
}

/**
 * 动态规划求静音吸附方案；参数无效或不存在满足约束的方案时返回 null。
 *
 * 边界按顺序展开为 t[0..2n]：t[0]=0 为虚拟起点，其后每条字幕的开始、结束
 * 依次各占一层。每层候选时间唯一且升序，每个时间只保留一个支配最优节点
 * （可行性只取决于当前时间，吸附数/位移的后续增量与来路无关）。
 * 层间用单调指针在时间升序的前驱窗口内取 (吸附数↑, 位移↓, 字典序排名↓)
 * 最优者；排名按 (前驱排名, 本层时间) 稠密编号——前缀序列相同（同一前驱）
 * 时再比当前时间，恰好是完整时间序列的字典序。
 */
export function planSilenceSnap(
  range: Subtitle[],
  data: WaveformData | null,
  settings: SilenceSettings
): SilencePlan | null {
  if (!data || range.length === 0 || !validSettings(settings)) return null;

  const segments = findSilenceSegments(data, settings);
  const n = range.length;

  // layers[0]：虚拟起点层；其后按开始/结束交替排列
  const layers: DpNode[][] = [
    [{ time: 0, snapped: 0, shift: 0, prev: -1, rank: 0, segment: null }],
  ];

  for (let b = 1; b <= 2 * n; b++) {
    const item = range[(b - 1) >> 1];
    const isStart = (b & 1) === 1; // 奇数层：某条字幕的开始
    const origin = Math.max(0, Math.round(isStart ? item.start : item.end));
    const cands = boundaryCandidates(origin, segments, settings.maxSnapMs);
    const prevLayer = layers[b - 1];

    // 前驱按时间升序，候选也按时间升序：指针只前进，维护窗口内最优前驱。
    const current: DpNode[] = [];
    let p = 0;
    let best: DpNode | null = null;
    let bestIdx = -1;

    for (const cand of cands) {
      // 开始边界：上一条结束 ≤ 本开始（端点相接允许）；
      // 结束边界：上一条开始 + 最小时长 ≤ 本结束。
      const limit = isStart ? cand.time : cand.time - settings.minDurationMs;
      while (p < prevLayer.length && prevLayer[p].time <= limit) {
        const st = prevLayer[p];
        if (
          !best ||
          st.snapped > best.snapped ||
          (st.snapped === best.snapped &&
            (st.shift < best.shift || (st.shift === best.shift && st.rank < best.rank)))
        ) {
          best = st;
          bestIdx = p;
        }
        p++;
      }
      if (!best) continue;
      const moved = cand.segment !== null; // 与原位置同时间的中点在候选生成时已去重
      current.push({
        time: cand.time,
        snapped: best.snapped + (moved ? 1 : 0),
        shift: best.shift + Math.abs(cand.time - origin),
        prev: bestIdx,
        rank: 0, // 下方统一编号
        segment: cand.segment,
      });
    }

    if (current.length === 0) return null; // 该层无可达候选 → 整个区间无可行方案

    // 字典序稠密排名：序列 = (前驱序列, 本层时间)，按键 (前驱排名, 时间) 排序编号。
    // current 当前按时间升序（同前驱内时间已升序）；跨前驱则按前驱的层内排名，
    // 注意排名不等于前驱在 prevLayer 中的时间序下标。
    current
      .map((_, idx) => idx)
      .sort((i, j) => {
        const ri = prevLayer[current[i].prev].rank;
        const rj = prevLayer[current[j].prev].rank;
        if (ri !== rj) return ri - rj;
        return current[i].time - current[j].time;
      })
      .forEach((nodeIdx, rank) => {
        current[nodeIdx].rank = rank;
      });

    layers.push(current);
  }

  // 末层在所有候选时间中取全局最优
  const last = layers[2 * n];
  let finalIdx = 0;
  for (let i = 1; i < last.length; i++) {
    const a = last[i];
    const b = last[finalIdx];
    if (
      a.snapped > b.snapped ||
      (a.snapped === b.snapped &&
        (a.shift < b.shift || (a.shift === b.shift && a.rank < b.rank)))
    ) {
      finalIdx = i;
    }
  }

  // 回溯各边界时间与吸附静音段
  const times = new Array<number>(2 * n + 1);
  const segs = new Array<SilenceSegment | null>(2 * n + 1).fill(null);
  let li = finalIdx;
  for (let b = 2 * n; b >= 1; b--) {
    const node = layers[b][li];
    times[b] = node.time;
    segs[b] = node.segment;
    li = node.prev;
  }
  times[0] = 0;

  let snappedCount = 0;
  let totalShiftMs = 0;
  let maxShiftMs = 0;
  let changed = 0;
  const items: SnappedItem[] = range.map((sub, k) => {
    const startMs = times[2 * k + 1];
    const endMs = times[2 * k + 2];
    const startSegment = segs[2 * k + 1];
    const endSegment = segs[2 * k + 2];
    const snapped = (startSegment ? 1 : 0) + (endSegment ? 1 : 0);
    const ds = Math.abs(startMs - sub.start);
    const de = Math.abs(endMs - sub.end);
    snappedCount += snapped;
    totalShiftMs += ds + de;
    maxShiftMs = Math.max(maxShiftMs, ds, de);
    if (startMs !== sub.start || endMs !== sub.end) changed++;
    return {
      id: sub.id,
      index: sub.index,
      startMs,
      endMs,
      oldStartMs: sub.start,
      oldEndMs: sub.end,
      startSegment,
      endSegment,
      snapped,
    };
  });

  return { items, snappedCount, totalShiftMs, maxShiftMs, changed };
}

/**
 * 应用方案：仅替换方案内字幕的起止时间，其余字幕（含 id、序号、文本）不变；
 * 返回新数组（不修改入参）。
 */
export function applySilenceSnap(subs: Subtitle[], plan: SilencePlan): Subtitle[] {
  const byId = new Map(plan.items.map((it) => [it.id, it]));
  return subs.map((s) => {
    const it = byId.get(s.id);
    if (!it || (it.startMs === s.start && it.endMs === s.end)) return s;
    return { ...s, start: it.startMs, end: it.endMs };
  });
}
