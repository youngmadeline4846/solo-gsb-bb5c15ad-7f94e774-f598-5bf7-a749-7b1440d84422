import { useMemo } from 'react';
import type { Subtitle } from '../types';
import type { WaveformData } from '../waveform';
import { formatTimestamp } from '../srt';
import { formatShift } from '../drift';
import {
  DEFAULT_SILENCE_SETTINGS,
  findSilenceSegments,
  planSilenceSnap,
  selectRange,
  validSettings,
  type SilencePlan,
  type SilenceSettings,
  type SilenceSegment,
} from '../silence';

/** 侧栏表单：区间两端字幕 id + 四个参数（阈值按 0–1 小数存储） */
export interface SilenceForm extends SilenceSettings {
  fromId: string | null;
  toId: string | null;
}

export const EMPTY_SILENCE_FORM: SilenceForm = {
  ...DEFAULT_SILENCE_SETTINGS,
  fromId: null,
  toId: null,
};

interface SilencePanelProps {
  subs: Subtitle[];
  /** 波形就绪时才有 data；未就绪时侧栏整体禁用 */
  waveformData: WaveformData | null;
  waveformStatus: 'idle' | 'decoding' | 'ready' | 'error';
  form: SilenceForm;
  onFormChange: (form: SilenceForm) => void;
  onApply: () => void;
  onJump: (id: string, sec: number) => void;
  selectedId: string | null;
}

/** 静音段预览文本：中点 + 段时长 */
function segmentLabel(seg: SilenceSegment): string {
  return `中点 ${formatTimestamp(seg.mid)} · 静音 ${(
    (seg.end - seg.start) /
    1000
  ).toFixed(3)}s`;
}

export default function SilencePanel({
  subs,
  waveformData,
  waveformStatus,
  form,
  onFormChange,
  onApply,
  onJump,
  selectedId,
}: SilencePanelProps) {
  const ready = waveformStatus === 'ready' && waveformData !== null;

  // 下拉按开始时间（相同按序号）排序，与区间选择逻辑一致
  const sorted = useMemo(() => [...subs].sort((a, b) => a.start - b.start || a.index - b.index), [subs]);

  const range = useMemo(
    () => (ready ? selectRange(subs, form.fromId, form.toId) : []),
    [ready, subs, form.fromId, form.toId]
  );

  const settings: SilenceSettings = useMemo(
    () => ({
      threshold: form.threshold,
      minSilenceMs: form.minSilenceMs,
      maxSnapMs: form.maxSnapMs,
      minDurationMs: form.minDurationMs,
    }),
    [form.threshold, form.minSilenceMs, form.maxSnapMs, form.minDurationMs]
  );

  const segments = useMemo(
    () => (ready ? findSilenceSegments(waveformData, settings) : []),
    [ready, waveformData, settings]
  );

  // 禁用应用的原因；null 表示存在可行方案
  const error = useMemo(() => {
    if (subs.length === 0) return '请先导入字幕';
    if (waveformStatus === 'decoding') return '音频波形解码中，就绪后可用';
    if (waveformStatus === 'error') return '音频波形解码失败，请重新导入视频后重试';
    if (!ready) return '请先导入含音轨的视频，待波形就绪后使用';
    if (!form.fromId || !form.toId) return '请选择连续字幕区间的起止条目';
    if (range.length === 0) return '区间字幕已不存在，请重新选择';
    if (!validSettings(settings))
      return '请检查参数：峰值阈值 0–100%，其余三项须为正数';
    if (segments.length === 0)
      return '当前阈值下未找到足够长的静音段，可调低峰值阈值或缩短最短静音长度';
    // 每个边界至少有原位置候选；若 DP 仍无解，必是时长 / 互不重叠约束无法满足
    const plan = planSilenceSnap(range, waveformData, settings);
    if (!plan)
      return `无可行方案：无法在满足「每条时长 ≥ ${settings.minDurationMs}ms 且互不重叠」的同时完成吸附，请放宽字幕最小时长或最大吸附距离`;
    if (plan.snappedCount === 0)
      return '最大吸附距离内没有可用的静音中点，方案不会改动任何时间（可增大吸附距离或调低阈值）';
    return null;
  }, [
    subs.length,
    waveformStatus,
    ready,
    form.fromId,
    form.toId,
    range,
    settings,
    segments.length,
    waveformData,
  ]);

  const plan: SilencePlan | null = useMemo(
    () => (ready && range.length > 0 && validSettings(settings)
      ? planSilenceSnap(range, waveformData, settings)
      : null),
    [ready, range, settings, waveformData]
  );

  const update = (patch: Partial<SilenceForm>) => onFormChange({ ...form, ...patch });

  const selectAll = () => {
    if (sorted.length === 0) return;
    update({ fromId: sorted[0].id, toId: sorted[sorted.length - 1].id });
  };

  const renderRangeSelect = (key: 'fromId' | 'toId', label: string) => (
    <div className="silence-field">
      <label className="silence-label">{label}</label>
      <select
        className="drift-select"
        disabled={!ready}
        value={form[key] ?? ''}
        onChange={(e) => update({ [key]: e.target.value || null } as Partial<SilenceForm>)}
      >
        <option value="" disabled>
          选择字幕…
        </option>
        {sorted.map((s) => (
          <option key={s.id} value={s.id}>
            #{s.index} · {formatTimestamp(s.start)} · {s.text.split('\n')[0] || '（空文本）'}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <aside className="silence-panel">
      <div className="drift-header">
        <span className="drift-title">🔇 静音吸附</span>
      </div>

      <div className="drift-body">
        {subs.length === 0 && <div className="merge-empty">先导入字幕，再使用静音吸附</div>}

        {subs.length > 0 && !ready && (
          <div className="silence-warn">
            {waveformStatus === 'decoding'
              ? '⏳ 音频波形解码中…完成后即可使用静音吸附'
              : waveformStatus === 'error'
                ? '⚠️ 音频波形解码失败，重新导入视频可重试'
                : '🎬 请先导入含音轨的视频：静音吸附仅在音频波形就绪时可用'}
          </div>
        )}

        {subs.length > 0 && (
          <>
            <div className="silence-section">
              <div className="silence-section-title">
                连续字幕区间
                <button className="btn btn-sm" disabled={!ready} onClick={selectAll}>
                  全选 {sorted.length} 条
                </button>
              </div>
              {renderRangeSelect('fromId', '区间起始字幕')}
              {renderRangeSelect('toId', '区间结束字幕')}
              {range.length > 0 && (
                <div className="dim">
                  共 {range.length} 条（#{range[0].index} – #{range[range.length - 1].index}），
                  仅这些条目的时间会被调整
                </div>
              )}
            </div>

            <div className="silence-section">
              <div className="silence-section-title">检测参数</div>
              <div className="silence-field">
                <label className="silence-label">
                  峰值阈值
                  <span className="silence-value">{(form.threshold * 100).toFixed(1)}%</span>
                </label>
                <input
                  type="range"
                  className="silence-range"
                  min={0}
                  max={0.5}
                  step={0.005}
                  disabled={!ready}
                  value={form.threshold}
                  onChange={(e) => update({ threshold: Number(e.target.value) })}
                />
                <div className="dim">桶峰值 max(|min|, |max|) ≤ 阈值即判为静音</div>
              </div>
              <div className="silence-field">
                <label className="silence-label">最短静音长度（ms）</label>
                <input
                  type="number"
                  className="drift-input"
                  min={1}
                  step={10}
                  disabled={!ready}
                  value={form.minSilenceMs}
                  onChange={(e) => update({ minSilenceMs: Number(e.target.value) })}
                />
              </div>
              <div className="silence-field">
                <label className="silence-label">最大吸附距离（ms）</label>
                <input
                  type="number"
                  className="drift-input"
                  min={1}
                  step={50}
                  disabled={!ready}
                  value={form.maxSnapMs}
                  onChange={(e) => update({ maxSnapMs: Number(e.target.value) })}
                />
              </div>
              <div className="silence-field">
                <label className="silence-label">字幕最小时长（ms）</label>
                <input
                  type="number"
                  className="drift-input"
                  min={1}
                  step={50}
                  disabled={!ready}
                  value={form.minDurationMs}
                  onChange={(e) => update({ minDurationMs: Number(e.target.value) })}
                />
              </div>
              {ready && (
                <div className="dim">
                  当前参数下检测到 <b>{segments.length}</b> 个静音段
                  {segments.length > 0 && (
                    <>
                      （最近：{formatTimestamp(segments[0].mid)}）
                    </>
                  )}
                </div>
              )}
            </div>

            {plan && (
              <div className="drift-summary">
                <span>
                  吸附边界 <b>{plan.snappedCount}</b> / {range.length * 2} · 改动{' '}
                  <b>{plan.changed}</b> 条 · 总位移{' '}
                  <b>{(plan.totalShiftMs / 1000).toFixed(3)}s</b> · 最大{' '}
                  <b>{(plan.maxShiftMs / 1000).toFixed(3)}s</b>
                </span>
                <span className="dim">
                  依次最大化吸附边界数、最小化总位移；同分取时间序列字典序较小方案
                </span>
              </div>
            )}

            {error && <div className="drift-error">{error}</div>}

            {plan && !error && (
              <div className="silence-rows">
                {plan.items.map((it) => {
                  const sub = subs.find((s) => s.id === it.id);
                  return (
                    <div
                      key={it.id}
                      className={`silence-row ${it.id === selectedId ? 'active' : ''} ${
                        it.snapped > 0 ? '' : 'unchanged'
                      }`}
                      onClick={() => onJump(it.id, Math.max(0, it.startMs) / 1000)}
                      title={sub?.text}
                    >
                      <div className="silence-row-head">
                        <span className="merge-pair-idx">#{it.index}</span>
                        <span className="silence-badges">
                          {it.startSegment && <i className="badge badge-snap">始↪静音</i>}
                          {it.endSegment && <i className="badge badge-snap">末↪静音</i>}
                          {it.snapped === 0 && <span className="dim">不变</span>}
                        </span>
                      </div>
                      <div className="silence-time">
                        <span className="silence-time-old">
                          {formatTimestamp(it.oldStartMs)} → {formatTimestamp(it.oldEndMs)}
                        </span>
                        <span className="silence-arrow">⇒</span>
                        <span className="silence-time-new">
                          {formatTimestamp(it.startMs)} → {formatTimestamp(it.endMs)}
                        </span>
                      </div>
                      {it.startSegment && (
                        <div className="silence-seg start">
                          <span className="silence-seg-tag">始</span>
                          {segmentLabel(it.startSegment)}（{formatShift(it.startMs - it.oldStartMs)}）
                        </div>
                      )}
                      {it.endSegment && (
                        <div className="silence-seg end">
                          <span className="silence-seg-tag">末</span>
                          {segmentLabel(it.endSegment)}（{formatShift(it.endMs - it.oldEndMs)}）
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="drift-footer">
        <button
          className="btn success"
          disabled={!ready || error !== null || !plan}
          onClick={onApply}
          title={
            !ready
              ? '音频波形就绪后可用'
              : error ?? '把区间内字幕边界吸附到静音中点，整批可一次撤销'
          }
        >
          ✅ 应用吸附
          {plan && error === null ? `（吸附 ${plan.snappedCount} 个边界）` : ''}
        </button>
      </div>
    </aside>
  );
}
