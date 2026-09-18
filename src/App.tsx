import { useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { Subtitle } from './types';
import { parseSrt, parseTimeInput, serializeSrt } from './srt';
import { detectIssues } from './issues';
import { alignSubtitles, applyMerge } from './merge';
import { applyDrift, planDrift, validateDrift } from './drift';
import { SAMPLE_SRT } from './sample';
import { useWaveform } from './useWaveform';
import Toolbar from './components/Toolbar';
import VideoPlayer from './components/VideoPlayer';
import Timeline from './components/Timeline';
import IssuesPanel from './components/IssuesPanel';
import RevisionMergePanel from './components/RevisionMergePanel';
import DriftPanel, { EMPTY_DRIFT_FORM } from './components/DriftPanel';
import type { DriftForm } from './components/DriftPanel';
import SilencePanel, { DEFAULT_SILENCE_FORM } from './components/SilencePanel';
import type { SilenceForm } from './components/SilencePanel';
import { applySilenceSnap, planSilenceSnap, resolveRange, parseSilenceParams } from './silence';
import './styles.css';

interface History {
  past: Subtitle[][];
  present: Subtitle[];
  future: Subtitle[][];
}

const EMPTY_HISTORY: History = { past: [], present: [], future: [] };

export default function App() {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const subs = history.present;

  const [srtName, setSrtName] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoName, setVideoName] = useState('');
  const [currentTime, setCurrentTime] = useState(0); // 秒
  const [videoDuration, setVideoDuration] = useState(0);
  const [chainMode, setChainMode] = useState(true);
  const [follow, setFollow] = useState(true);
  const [pxPerSec, setPxPerSec] = useState(80);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [showDrift, setShowDrift] = useState(false);
  const [showSilence, setShowSilence] = useState(false);
  // 漂移校准表单（锚点选择 + 目标时间输入），面板关闭后保留，重新导入字幕时重置
  const [driftForm, setDriftForm] = useState<DriftForm>(EMPTY_DRIFT_FORM);
  // 静音吸附表单（连续区间 + 阈值等参数），面板关闭后保留，重新导入字幕时重置
  const [silenceForm, setSilenceForm] = useState<SilenceForm>(DEFAULT_SILENCE_FORM);
  // 修订稿独立于当前字幕保存：导入不会替换当前时间轴
  const [revision, setRevision] = useState<Subtitle[]>([]);
  const [revisionName, setRevisionName] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const { waveform, loadWaveform, dismissWaveform } = useWaveform();

  const issues = useMemo(() => detectIssues(subs), [subs]);

  const waveformReady = waveform.status === 'ready';

  // 波形失效（切换视频 / 关闭波形 / 解码失败）后，静音吸附侧栏自动收起：
  // 面板仅在音频波形就绪时可用
  useEffect(() => {
    if (!waveformReady) setShowSilence(false);
  }, [waveformReady]);

  // 对齐计算较重（大文件毫秒到秒级），用 deferred 值避免拖动字幕时的高频更新阻塞交互；
  // 应用合并（applyRevision）始终基于 history.present 即时重算，不受延迟影响。
  const deferredSubs = useDeferredValue(subs);
  const deferredRevision = useDeferredValue(revision);
  const mergeResult = useMemo(
    () => (deferredRevision.length > 0 ? alignSubtitles(deferredSubs, deferredRevision) : null),
    [deferredSubs, deferredRevision]
  );

  // ---- 历史操作 ----
  /** 拖动结束：把拖动前快照压入历史（present 已在拖动过程中实时更新） */
  const commitDrag = useCallback((before: Subtitle[]) => {
    setHistory((h) => ({ ...h, past: [...h.past, before], future: [] }));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length === 0
        ? h
        : {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
          }
    );
  }, []);

  const redo = useCallback(() => {
    setHistory((h) =>
      h.future.length === 0
        ? h
        : {
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
          }
    );
  }, []);

  const liveChange = useCallback((next: Subtitle[]) => {
    setHistory((h) => ({ ...h, present: next }));
  }, []);

  // ---- 文件导入导出 ----
  const loadSrt = useCallback((content: string, name: string) => {
    const parsed = parseSrt(content);
    setHistory({ past: [], present: parsed, future: [] });
    setSrtName(name);
    setSelectedId(null);
    setCurrentTime(0);
    // 新字幕载入后，旧修订稿的匹配与旧锚点（id 已失效）一并清空
    setRevision([]);
    setRevisionName('');
    setDriftForm(EMPTY_DRIFT_FORM);
    setSilenceForm(DEFAULT_SILENCE_FORM);
  }, []);

  const importSrt = useCallback(
    async (file: File) => loadSrt(await file.text(), file.name),
    [loadSrt]
  );

  const importRevision = useCallback(
    async (file: File) => {
      const parsed = parseSrt(await file.text());
      setRevision(parsed);
      setRevisionName(file.name);
    },
    []
  );

  const clearRevision = useCallback(() => {
    setRevision([]);
    setRevisionName('');
  }, []);

  // 应用修订稿合并：仅已匹配条目的文本写回当前字幕，id / 序号 / 时间保留，
  // 整批作为一次撤销/重做操作
  const applyRevision = useCallback(() => {
    setHistory((h) => {
      if (revision.length === 0) return h;
      const result = alignSubtitles(h.present, revision);
      if (result.pairs.length === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applyMerge(h.present, revision, result),
        future: [],
      };
    });
  }, [revision]);

  // 应用双锚点漂移校准：所有字幕按锚点方案同步平移（时长不变），
  // 整批作为一次撤销/重做操作
  const applyDriftCalibration = useCallback(() => {
    const inputA = { id: driftForm.a.id, targetStart: parseTimeInput(driftForm.a.target) };
    const inputB = { id: driftForm.b.id, targetStart: parseTimeInput(driftForm.b.target) };
    setHistory((h) => {
      // 基于 history.present 即时校验并重算方案，与面板预览使用同一套规则
      if (validateDrift(h.present, inputA, inputB) !== null) return h;
      const plan = planDrift(h.present, inputA, inputB);
      if (!plan || plan.affected === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applyDrift(h.present, plan.offsets),
        future: [],
      };
    });
  }, [driftForm]);

  // 应用静音吸附：所选连续字幕的起止边界吸附到静音中点（保持顺序、
  // 每条时长达标且互不重叠），整批作为一次撤销/重做操作
  const applySilence = useCallback(() => {
    setHistory((h) => {
      if (waveform.status !== 'ready' || !waveform.data) return h;
      const parsed = parseSilenceParams(silenceForm);
      if (!parsed.ok) return h;
      const targets = resolveRange(h.present, silenceForm.fromId, silenceForm.toId);
      if (!targets) return h;
      // 应用时基于 history.present 即时重算，与面板预览使用同一套规则
      const plan = planSilenceSnap(targets, waveform.data, parsed.params);
      if (!plan || plan.moved === 0) return h;
      return {
        past: [...h.past, h.present],
        present: applySilenceSnap(h.present, plan),
        future: [],
      };
    });
  }, [silenceForm, waveform]);

  const importVideo = useCallback(    (file: File) => {
      setVideoUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(file);
      });
      setVideoName(file.name);
      // 浏览器内解码音轨生成波形；失败仅影响波形轨道，不影响字幕编辑。
      // 旧视频的波形数据随状态替换释放，不会累积在内存中。
      loadWaveform(file);
    },
    [loadWaveform]
  );

  const loadSample = useCallback(() => loadSrt(SAMPLE_SRT, '示例字幕.srt'), [loadSrt]);

  const exportSrt = useCallback(() => {
    const blob = new Blob([serializeSrt(subs)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = srtName ? srtName.replace(/\.srt$/i, '') + '.fixed.srt' : 'fixed.srt';
    a.click();
    URL.revokeObjectURL(url);
  }, [subs, srtName]);

  // ---- 播放与跳转 ----
  const seekTo = useCallback((sec: number) => {
    if (videoRef.current) videoRef.current.currentTime = sec;
    setCurrentTime(sec);
  }, []);

  const jumpTo = useCallback(
    (id: string, sec: number) => {
      setSelectedId(id);
      seekTo(sec);
    },
    [seekTo]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setHistory((h) => ({
      past: [...h.past, h.present],
      present: h.present.filter((s) => s.id !== selectedId),
      future: [],
    }));
    setSelectedId(null);
  }, [selectedId]);

  // ---- 快捷键 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectedId, deleteSelected]);

  // 时间轴总时长：视频时长、字幕末尾、30 秒下限，再留 10 秒余量
  const timelineDuration =
    Math.max(videoDuration, ...subs.map((s) => s.end / 1000), 30) + 10;

  return (
    <div className="app">
      <Toolbar
        srtName={srtName}
        videoName={videoName}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        chainMode={chainMode}
        follow={follow}
        pxPerSec={pxPerSec}
        hasSubs={subs.length > 0}
        hasSelection={selectedId !== null}
        showMerge={showMerge}
        showDrift={showDrift}
        showSilence={showSilence}
        canSilence={waveformReady}
        onImportSrt={importSrt}
        onImportVideo={importVideo}
        onLoadSample={loadSample}
        onExport={exportSrt}
        onUndo={undo}
        onRedo={redo}
        onToggleChain={setChainMode}
        onToggleFollow={setFollow}
        onZoom={setPxPerSec}
        onDeleteSelected={deleteSelected}
        onToggleMerge={() => {
          // 侧栏互斥，避免同时挤压视频区
          setShowMerge((v) => !v);
          setShowDrift(false);
          setShowSilence(false);
        }}
        onToggleDrift={() => {
          setShowDrift((v) => !v);
          setShowMerge(false);
          setShowSilence(false);
        }}
        onToggleSilence={() => {
          // 三个侧栏互斥；未就绪时按钮禁用，这里再兜底一次
          if (!waveformReady) return;
          setShowSilence((v) => !v);
          setShowMerge(false);
          setShowDrift(false);
        }}
      />

      <main className="main">
        <section className="top-row">
          <VideoPlayer
            url={videoUrl}
            name={videoName}
            videoRef={videoRef}
            onTimeUpdate={setCurrentTime}
            onDuration={setVideoDuration}
          />
          <IssuesPanel subs={subs} issues={issues} selectedId={selectedId} onJump={jumpTo} />
          {showMerge && (
            <RevisionMergePanel
              subs={subs}
              revision={revision}
              revisionName={revisionName}
              result={mergeResult}
              selectedId={selectedId}
              onImportRevision={importRevision}
              onApply={applyRevision}
              onClear={clearRevision}
              onJump={jumpTo}
            />
          )}
          {showDrift && (
            <DriftPanel
              subs={subs}
              currentTime={currentTime}
              form={driftForm}
              onFormChange={setDriftForm}
              onApply={applyDriftCalibration}
            />
          )}
          {showSilence && waveformReady && (
            <SilencePanel
              subs={subs}
              waveform={waveform}
              form={silenceForm}
              onFormChange={setSilenceForm}
              selectedId={selectedId}
              onJump={jumpTo}
              onApply={applySilence}
            />
          )}
        </section>

        <Timeline
          subs={subs}
          issues={issues}
          duration={timelineDuration}
          pxPerSec={pxPerSec}
          currentTime={currentTime}
          chainMode={chainMode}
          selectedId={selectedId}
          follow={follow}
          waveform={waveform}
          onSelect={setSelectedId}
          onSeek={seekTo}
          onLiveChange={liveChange}
          onDragCommit={commitDrag}
          onDismissWaveform={dismissWaveform}
        />
      </main>
    </div>
  );
}
