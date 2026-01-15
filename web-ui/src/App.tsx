import { useState, useEffect, useCallback, useRef } from 'react';
import './App.css';

const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV ? 'http://localhost:3000' : '');

type AppStep = 'upload' | 'split-preview' | 'indexing' | 'planning' | 'executing' | 'branching';
type PlanMode = 'auto' | 'split' | 'merge' | 'one_to_one';

interface FileChapter {
  filename: string;
  number: number;
  title: string;
  content: string;
}

interface EventPlan {
  id: number;
  type: 'highlight' | 'normal';
  startChapter: number;
  endChapter: number;
  description: string;
}

interface Node {
  id: number;
  type: string;
  description: string;
  status: 'pending' | 'generating' | 'completed' | 'error';
  content?: string;
  startChapter: number;
  endChapter: number;
  qualityScore?: number;
  reviewIssues?: string[];
  // Optional branch metadata (present for auto-generated side branches)
  branchKind?: 'divergent' | 'convergent';
  parentNodeId?: number;
  returnToNodeId?: number | null;
}

interface LogEntry {
  type: string;
  message: string;
  timestamp: string;
}

interface ReviewResult {
  nodeId: number;
  score: number;
  issues: string[];
}

interface SplitPreview {
  chapters: Array<{ number: number; title: string; contentLength: number; contentPreview: string }>;
  detectedLanguage: 'cn' | 'en' | 'mixed';
  totalChars: number;
}

// Helpers
function extractChapterNumber(filename: string, index: number): number {
  const match = filename.match(/第(\d+)章|(\d+)/);
  return match ? parseInt(match[1] || match[2], 10) : index + 1;
}

function extractTitle(filename: string, number: number): string {
  const title = filename.replace(/\.(txt|md)$/i, '');
  return /第\d+章/.test(title) ? title : `第${number}章 ${title}`;
}

export default function App() {
  // Core state
  const [step, setStep] = useState<AppStep>('upload');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [files, setFiles] = useState<FileChapter[]>([]);
  const [autoSplit, setAutoSplit] = useState(false);
  // Whether to apply the character renaming pipeline after generation
  const [remapCharacters, setRemapCharacters] = useState(false);
  const [chapterCount, setChapterCount] = useState(0);
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null);
  const [previewingChapterIdx, setPreviewingChapterIdx] = useState<number | null>(null);
  const [deletedChapterIndices, setDeletedChapterIndices] = useState<Set<number>>(new Set());
  const [lang, setLang] = useState<'cn' | 'en'>('cn'); // Language state

  // Planning state
  const [planMode, setPlanMode] = useState<PlanMode>('auto');
  const [targetNodeCount, setTargetNodeCount] = useState<number>(10);
  const [planStats, setPlanStats] = useState<{
    recommended?: number;
    actual?: number;
    user?: number | null;
  } | null>(null);

  // Effect to lock node count in 1:1 mode
  useEffect(() => {
    if (planMode === 'one_to_one' && chapterCount > 0) {
      setTargetNodeCount(chapterCount);
    }
  }, [planMode, chapterCount]);
  const [customInstructions, setCustomInstructions] = useState('');
  const [events, setEvents] = useState<EventPlan[]>([]);
  const [editingEvent, setEditingEvent] = useState<number | null>(null);

  // Generation state
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [nodeViewMode, setNodeViewMode] = useState<'main' | 'branch'>('main');
  const [characterMap, setCharacterMap] = useState<Record<string, string>>({});
  const [, setGeneratingNodeId] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  const [nextStepInstruction, setNextStepInstruction] = useState('');
  const [autoReview, setAutoReview] = useState(true);
  const [isBatchReviewing, setIsBatchReviewing] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isAdjustingPlan, setIsAdjustingPlan] = useState(false);
  const [isBranching, setIsBranching] = useState(false);
  const [branchingTaskId, setBranchingTaskId] = useState<string | null>(null);

  // Simple i18n helper
  const tr = useCallback(
    (cn: string, en: string) => (lang === 'en' ? en : cn),
    [lang]
  );

  // UI state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [reviewResults, setReviewResults] = useState<ReviewResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const thoughtsRef = useRef<HTMLDivElement>(null);

  // Logging
  const addLog = useCallback((type: string, message: string) => {
    setLogs(prev => [{
      type, message,
      timestamp: new Date().toLocaleTimeString()
    }, ...prev].slice(0, 100));
  }, []);

  // Restore session on mount
  useEffect(() => {
    const saved = localStorage.getItem('wash_session');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (data.sessionId && data.step !== 'upload') {
          setSessionId(data.sessionId);
          setSessionName(data.sessionName || '');
          setStep(data.step);
          setChapterCount(data.chapterCount || 0);
          setEvents(data.events || []);
          setNodes(data.nodes || []);
          setPlanMode(data.planMode || 'auto');
          setTargetNodeCount(data.targetNodeCount || 10);
          if (typeof data.remapCharacters === 'boolean') {
            setRemapCharacters(data.remapCharacters);
          }
          console.log('Session restored:', data.sessionId);
        }
      } catch { }
    }
    setInitialized(true);

    // Fetch system config
    fetch(`${API_BASE}/api/config`)
      .then(res => res.json())
      .then(data => {
        if (data.language) setLang(data.language);
      })
      .catch(() => { });
  }, []);

  // Save session
  useEffect(() => {
    if (!initialized || !sessionId) return;
    localStorage.setItem('wash_session', JSON.stringify({
      sessionId, sessionName, step, chapterCount,
      events, nodes, planMode, targetNodeCount,
      remapCharacters,
      savedAt: new Date().toISOString()
    }));
  }, [initialized, sessionId, sessionName, step, chapterCount, events, nodes, planMode, targetNodeCount, remapCharacters]);

  // Helper: fetch latest plan from server
  const fetchPlanFromServer = useCallback(async () => {
    if (!sessionId) return;
    try {
      const planRes = await fetch(`${API_BASE}/api/sessions/${sessionId}/plan`);
      const planData = await planRes.json();
      if (planData.events?.length > 0) setEvents(planData.events);

      const analysis = planData.analysis || {};
      const recommended = analysis.targetNodeCount as number | undefined;
      const actual = (analysis.lastPlanEventCount as number | undefined) || (planData.events?.length || 0);
      const user = (analysis.lastPlanUserTarget as number | null | undefined) ?? null;

      setPlanStats({ recommended, actual, user });

      // 如果后端有推荐 targetNodeCount，就在 auto 且当前为 0 时同步到 UI；否则不覆盖用户输入
      if (planMode === 'auto' && (!targetNodeCount || targetNodeCount === 0) && recommended) {
        setTargetNodeCount(recommended);
      }

      // Also fetch characterMap once we enter planning
      try {
        const sessionRes = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();
          setCharacterMap(sessionData.characterMap || {});
        }
      } catch {
        // ignore characterMap fetch errors
      }

      setStep('planning');
    } catch { }
  }, [sessionId, planMode, targetNodeCount, setEvents, setPlanStats, setTargetNodeCount, setStep]);

  // Helper: sync latest nodes from server (for executing step or when page reloads)
  const syncNodesFromServer = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/nodes`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.nodes)) {
        setNodes(data.nodes as Node[]);
      }
    } catch {
      // best-effort sync; ignore errors
    }
  }, [sessionId]);

  // On init + session restore, resync from server to avoid stale UI when SSE or dev HMR dropped
  useEffect(() => {
    if (!initialized || !sessionId) return;
    if (step === 'planning') {
      fetchPlanFromServer();
    } else if (step === 'executing') {
      syncNodesFromServer();
    }
  }, [initialized, sessionId, step, fetchPlanFromServer, syncNodesFromServer]);

  // SSE subscription with thought stream
  useEffect(() => {
    if (!taskId) return;
    const evtSource = new EventSource(`${API_BASE}/api/tasks/${taskId}/events`);

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === 'thought') {
          // Real-time thought stream
          setThoughts(prev => [...prev, data.message].slice(-20));
          if (thoughtsRef.current) {
            thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
          }
          } else if (data.type === 'node_ready') {
          // Node completed - can view immediately
          const nodeId = data.data?.nodeId;
          if (nodeId) {
            setNodes(prev => prev.map(n =>
              n.id === nodeId ? { ...n, status: 'completed', content: data.data?.content } : n
            ));
            setGeneratingNodeId(null);
            addLog('complete', tr(`节点 #${nodeId} 生成完成`, `Node #${nodeId} generated`));
          }
        } else if (data.type === 'node_start') {
          setGeneratingNodeId(data.data?.nodeId);
          // 不清除思考流，保留上一节点的思考记录
        } else if (data.type === 'progress') {
          setProgress(data.data?.progress || 0);
          setProgressMessage(data.message);
          addLog('progress', data.message);
        } else if (data.type === 'log') {
          addLog('log', data.message);

          // 分支相关的日志也会进入思考流，以便右侧实时展示 Brancher 进度
          if (typeof data.message === 'string' && data.message.includes('[Brancher]')) {
            setThoughts(prev => [...prev, data.message].slice(-20));
            if (thoughtsRef.current) {
              thoughtsRef.current.scrollTop = thoughtsRef.current.scrollHeight;
            }

            // 当 Brancher 报告某个 branchId 已生成时，增量刷新一次节点列表，
            // 这样支线节点可以像主线一样一条条出现在左侧列表中。
            const branchId = data.data?.branchId as number | undefined;
            if (branchId && branchingTaskId && taskId === branchingTaskId) {
              syncNodesFromServer();
            }
          }

          const nodeId = data.data?.nodeId as number | undefined;
          const score = data.data?.score as number | undefined;
          const issues = (data.data?.issues as string[] | undefined) ?? [];
          if (nodeId && typeof score === 'number') {
            // 更新对应节点的打分
            setNodes(prev => prev.map(n =>
              n.id === nodeId ? { ...n, qualityScore: score, reviewIssues: issues } : n
            ));
            // 右侧 Review 结果面板也同步这个节点
            setReviewResults(prev => {
              const others = prev.filter(r => r.nodeId !== nodeId);
              return [{ nodeId, score, issues }, ...others].slice(0, 100);
            });
          }
        } else if (data.type === 'reroll') {
          addLog('reroll', data.message);
        } else if (data.type === 'complete') {
          addLog('complete', data.message);
          setProgress(100);

          // Capture review results when present
          if (data.data?.reviews) {
            const reviews = (data.data.reviews as any[]).map(r => ({
              nodeId: r.nodeId,
              score: r.score,
              issues: r.issues ?? [],
            }));
            setReviewResults(reviews);
          }

          // If this task is an auto-branching job, refresh nodes from server
          // so newly created branch nodes appear in the UI, then clear the
          // branching task marker, switch to branch mode, and stop further
          // step-based handling.
          if (branchingTaskId && taskId === branchingTaskId) {
            syncNodesFromServer();
            setStep('branching');
            setNodeViewMode('branch');
            setBranchingTaskId(null);
            setTaskId(null);
          } else if (step === 'indexing') {
            // 索引完成后自动进入规划阶段
            setTaskId(null);
            handleGeneratePlan();
          } else if (step === 'planning') {
            // 规划任务完成后，拉取最新规划结果
            fetchPlanFromServer();
            setTaskId(null);
            setIsPlanning(false);
          } else if (step === 'executing') {
            // 生成 / 批量 review 结束
            addLog('success', data.message);
            setTaskId(null);
            setIsBatchReviewing(false);
          } else if (step === 'branching') {
            addLog('success', data.message);
            setTaskId(null);
          } else {
            setTaskId(null);
          }
        } else if (data.type === 'error') {
          // Surface worker errors clearly到前端，并停止当前任务监听
          setError(data.message);
          addLog('error', data.message);
          setTaskId(null);
          setLoading(false);
        } else if (data.type === 'paused') {
          setIsPaused(true);
          addLog('log', '任务已暂停');
        }
      } catch { }
    };

    evtSource.onerror = () => evtSource.close();
    return () => evtSource.close();
  }, [taskId, step, addLog, fetchPlanFromServer, branchingTaskId, syncNodesFromServer]);

  // File handling
  const handleFileSelect = useCallback(async (selectedFiles: FileList | File[]) => {
    const fileArray = Array.from(selectedFiles).filter(f =>
      f.name.endsWith('.txt') || f.name.endsWith('.md')
    );
    if (fileArray.length === 0) {
      setError(tr('请选择 .txt 或 .md 格式的文件', 'Please select .txt or .md files'));
      return;
    }

    const chapters = await Promise.all(
      fileArray.map((file, idx) =>
        new Promise<FileChapter>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const content = e.target?.result as string || '';
            const number = extractChapterNumber(file.name, idx);
            resolve({ filename: file.name, number, title: extractTitle(file.name, number), content });
          };
          reader.onerror = reject;
          reader.readAsText(file);
        })
      )
    );
    chapters.sort((a, b) => a.number - b.number);
    setFiles(chapters);
    setError(null);
    if (!sessionName && chapters.length > 0) {
      setSessionName(
        chapters[0].filename
          .replace(/\.(txt|md)$/i, '')
          .replace(/第\d+章.*/, '')
          .trim() || (lang === 'en' ? 'New Novel' : '新小说')
      );
    }
  }, [sessionName]);

  // Upload and index
  const handleUpload = async () => {
    if (files.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      // If auto-split is ON and single file, show preview first
      if (autoSplit && files.length === 1) {
        const content = files[0].content;
        const previewRes = await fetch(`${API_BASE}/api/preview-split`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        const previewData = await previewRes.json();
        if (!previewRes.ok) throw new Error(previewData.error || tr('预览失败', 'Preview failed'));

        setSplitPreview({
          chapters: previewData.chapters,
          detectedLanguage: previewData.detectedLanguage,
          totalChars: previewData.totalChars,
        });
        setStep('split-preview');
        setLoading(false);
        return;
      }

      // Direct upload (multi-file or no auto-split)
      await performUpload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Confirm split and proceed to upload
  const handleConfirmSplit = async () => {
    setLoading(true);
    setError(null);
    try {
      await performUpload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Cancel split preview
  const handleCancelSplit = () => {
    setSplitPreview(null);
    setDeletedChapterIndices(new Set());
    setPreviewingChapterIdx(null);
    setStep('upload');
  };

  // Actual upload logic
  const performUpload = async () => {
    // Create session
    const sessionRes = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sessionName || '新小说' }),
    });
    const sessionData = await sessionRes.json();
    const newSessionId = sessionData.session.id;
    setSessionId(newSessionId);

    // Upload content
    const content = autoSplit && files.length === 1
      ? files[0].content
      : files.map(f => `第${f.number}章 ${f.title.replace(/^第\d+章\s*/, '')}\n\n${f.content}`).join('\n\n');

    const uploadRes = await fetch(`${API_BASE}/api/sessions/${newSessionId}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || tr('上传失败', 'Upload failed'));

    setChapterCount(uploadData.chapterCount);
    setTargetNodeCount(Math.round(uploadData.chapterCount * 0.8));
    addLog('upload', lang === 'en'
      ? `Upload succeeded: ${uploadData.chapterCount} chapters`
      : `上传成功: ${uploadData.chapterCount} 章`);

    // Clear preview state
    setSplitPreview(null);

    // Start indexing
    setStep('indexing');
    setProgress(0);
    const indexRes = await fetch(`${API_BASE}/api/sessions/${newSessionId}/index`, { method: 'POST' });
    const indexData = await indexRes.json();
    setTaskId(indexData.taskId);
  };

  // Generate plan with mode
  const handleGeneratePlan = async () => {
    if (!sessionId) return;
    setLoading(true);
    setIsPlanning(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: planMode,
          // 让后端/模型先给出推荐节点数；仅当用户在 UI 修改时再发具体值
          targetNodeCount: planMode === 'auto' && targetNodeCount === 0 ? undefined : targetNodeCount,
          customInstructions,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || tr('规划失败', 'Planning failed'));
      }
      // 进入规划步骤，等待 SSE 通知完成后再拉取结果
      setStep('planning');
      setPlanStats(null);
      setEvents([]);
      setTaskId(data.taskId);
      addLog('plan', lang === 'en'
        ? `Planning task started: ${data.taskId}`
        : `启动规划任务: ${data.taskId}`);
    } catch (e: any) {
      setError(e.message);
      setIsPlanning(false);
    } finally {
      setLoading(false);
    }
  };

  // Re-roll plan
  const handleRerollPlan = () => {
    handleGeneratePlan();
  };

  // Butterfly-effect micro-tuning on top of current edited events
  const handleAdjustPlan = async () => {
    if (!sessionId || events.length === 0) return;
    setIsAdjustingPlan(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/plan/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: planMode,
          targetNodeCount: targetNodeCount || events.length,
          events,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || tr('微调失败', 'Adjust plan failed'));
      }
      if (Array.isArray(data.events)) {
        setEvents(data.events as EventPlan[]);
      }
      if (data.analysis) {
        setPlanStats({
          recommended: (data.analysis as any).targetNodeCount,
          actual: (data.analysis as any).lastPlanEventCount,
          user: (data.analysis as any).lastPlanUserTarget ?? null,
        });
      }
      addLog('plan', tr('已基于当前规划进行蝴蝶效应微调', 'Butterfly-effect tweak applied on current plan'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsAdjustingPlan(false);
    }
  };

  // Edit event
  const handleUpdateEvent = (id: number, field: keyof EventPlan, value: any) => {
    setEvents(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  };

  // Delete event
  const handleDeleteEvent = (id: number) => {
    if (confirm(tr('确定删除此事件？', 'Delete this event?'))) {
      setEvents(prev => prev.filter(e => e.id !== id));
    }
  };

  // Confirm and generate
  const handleConfirmAndGenerate = async () => {
    if (!sessionId) return;
    setLoading(true);

    try {
      await fetch(`${API_BASE}/api/sessions/${sessionId}/plan`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events, confirmed: true }),
      });

      // Initialize nodes from events
      setNodes(events.map(e => ({
        id: e.id,
        type: e.type,
        description: e.description,
        status: 'pending',
        startChapter: e.startChapter,
        endChapter: e.endChapter,
      })));

      setStep('executing');
      setProgress(0);
      setThoughts([]);

      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoReview, remapCharacters })
      });
      const data = await res.json();
      setTaskId(data.taskId);
      addLog('generate', tr('开始生成节点...', 'Start generating nodes...'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Pause generation
  const handlePause = async () => {
    if (!sessionId) return;
    await fetch(`${API_BASE}/api/sessions/${sessionId}/pause`, { method: 'POST' });
    setIsPaused(true);
  };

  // Resume generation
  const handleResume = async () => {
    if (!sessionId) return;
    await fetch(`${API_BASE}/api/sessions/${sessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: nextStepInstruction }),
    });
    setIsPaused(false);
    setNextStepInstruction('');
  };

  // Re-roll single node
  const handleRerollNode = async (nodeId: number) => {
    if (!sessionId) return;
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, status: 'generating', content: undefined } : n));
    setGeneratingNodeId(nodeId);
    // Don't clear thoughts - let them accumulate

    // Fetch and handle response to get taskId for event subscription
    fetch(`${API_BASE}/api/sessions/${sessionId}/nodes/${nodeId}/reroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoReview, remapCharacters }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.success && data.taskId) {
          // Update taskId so SSE subscription picks up reroll events
          setTaskId(data.taskId);
        }
      })
      .catch(err => {
        console.error('Reroll request failed:', err);
        setError(tr('重roll请求失败', 'Reroll request failed'));
        // Reset node status on failure
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, status: 'completed' } : n));
        setGeneratingNodeId(null);
      });

    addLog('reroll', tr(`重新生成节点 #${nodeId}`, `Regenerating node #${nodeId}`));
  };

  // Restart
  const handleRestart = () => {
    if (confirm(tr('确定要重新开始吗？当前进度将被清除。', 'Start over? Current progress will be cleared.'))) {
      localStorage.removeItem('wash_session');
      window.location.reload();
    }
  };

  // Export to ZIP
  const handleExport = () => {
    if (!sessionId) return;
    window.location.href = `${API_BASE}/api/sessions/${sessionId}/export`;
  };

  const handleStartBranching = async () => {
    if (!sessionId) return;
    setIsBranching(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || tr('自动支线任务创建失败', 'Failed to start auto-branching'));
      }
      setTaskId(data.taskId);
      setBranchingTaskId(data.taskId);
      // Immediately switch UI into branching mode so the user knows we're in
      // "branch workspace" even while branches are being generated.
      setStep('branching');
      setNodeViewMode('branch');
      setThoughts([]);
      addLog('plan', tr('已启动自动支线生成任务', 'Auto-branching task started'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsBranching(false);
    }
  };

  // Batch review (manual, when autoReview is off)
  const handleBatchReview = async () => {
    if (!sessionId) return;
    setIsBatchReviewing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoFix: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Review 任务创建失败');
      }
      setTaskId(data.taskId);
      addLog('review', tr('开始批量 Review...', 'Start batch review...'));
    } catch (e: any) {
      setError(e.message);
      setIsBatchReviewing(false);
    }
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
  const completedNodes = nodes.filter(n => n.status === 'completed').length;

  // When entering branch view with available branch nodes, auto-select the
  // first branch node to avoid an "empty" editor feeling.
  useEffect(() => {
    if (!nodes.length) return;
    if (!(step === 'executing' || step === 'branching')) return;
    if (nodeViewMode !== 'branch') return;

    const branchNodes = nodes.filter(n => !!n.branchKind);
    if (!branchNodes.length) return;

    const currentlySelectedIsBranch = branchNodes.some(n => n.id === selectedNodeId);
    if (!currentlySelectedIsBranch) {
      setSelectedNodeId(branchNodes[0].id);
    }
  }, [step, nodeViewMode, nodes, selectedNodeId]);

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1>🌊 Wash 2.0</h1>
          {sessionName && <span className="session-name">📖 {sessionName}</span>}
        </div>
        <div className="header-right">
          {step === 'executing' && (
            <>
              <button onClick={handleStartBranching} className="btn btn-secondary" style={{ marginRight: '0.5rem' }}>
                {isBranching ? tr('🧬 支线中...', '🧬 Branching...') : tr('🧬 自动支线', '🧬 Auto-branch')}
              </button>
              <button onClick={handleExport} className="btn btn-secondary" style={{ marginRight: '1rem' }}>
                {tr('📦 导出 ZIP', '📦 Export ZIP')}
              </button>
            </>
          )}
          {step !== 'upload' && (
            <button onClick={handleRestart} className="btn btn-ghost">
              {lang === 'en' ? '🔄 New Task' : '🔄 新建任务'}
            </button>
          )}
        </div>
      </header>

      {/* Step Navigation */}
      {step !== 'upload' && (
        <nav className="step-nav">
          {['upload', 'indexing', 'planning', 'executing'].map((s, i) => {
            const labels = ['上传', '索引', '规划', '工作台'];
            const icons = ['📁', '🔍', '📋', '💻'];
            const navSteps: AppStep[] = ['upload', 'indexing', 'planning', 'executing'];
            const currentStepForNav: AppStep = step === 'branching' ? 'executing' : step;
            const currentIdx = navSteps.indexOf(currentStepForNav);
            return (
              <div key={s}
                className={`step-item ${s === currentStepForNav ? 'active' : ''} ${i < currentIdx ? 'passed' : ''}`}
                onClick={() => (i <= currentIdx || s === currentStepForNav) && setStep(navSteps[i])}
                style={{ cursor: (i <= currentIdx || s === currentStepForNav) ? 'pointer' : 'default' }}>
                <span>{icons[i]}</span>
                <span>{lang === 'en' ? ['Upload', 'Index', 'Plan', 'Workbench'][i] : labels[i]}</span>
              </div>
            );
          })}
        </nav>
      )}

      {error && (
        <div className="error-banner">
          <span>❌ {error}</span>
          {step === 'planning' && error.includes('Planning failed') && (
            <button
              onClick={() => {
                setError(null);
                handleGeneratePlan();
              }}
              className="btn btn-ghost"
              style={{ marginLeft: '0.5rem' }}
            >
              {tr('🔁 重试规划', '🔁 Retry planning')}
            </button>
          )}
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <main className="main">
        {/* UPLOAD */}
        {step === 'upload' && (
          <div className="upload-view">
            <div className="upload-header">
              <h2>{tr('📁 上传小说', '📁 Upload Novel')}</h2>
              <p>{tr('上传小说章节文件，支持多选或拖拽', 'Upload chapter files, support multi-select or drag & drop')}</p>
            </div>

            <input
              type="text"
              placeholder={tr('小说名称', 'Novel name')}
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              className="input"
            />

            <div className="file-input-row">
              <input ref={fileInputRef} type="file" accept=".txt,.md" multiple style={{ display: 'none' }}
                onChange={(e) => e.target.files && handleFileSelect(e.target.files)} />
              <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary">
                {tr('📁 选择文件', '📁 Choose files')}
              </button>
              {files.length > 0 && (
                <button onClick={() => setFiles([])} className="btn btn-ghost">
                  {tr('清空', 'Clear')}
                </button>
              )}
              <span className="file-hint">{tr('支持多选 .txt/.md', 'Multi-select .txt/.md supported')}</span>
            </div>

            <div className={`file-drop-zone ${dragOver ? 'dragover' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFileSelect(e.dataTransfer.files); }}>
              {files.length === 0 ? (
                <>
                  <span className="upload-icon">📤</span>
                  <p>{tr('拖放文件到此处', 'Drop files here')}</p>
                </>
              ) : (
                <div className="file-list">
                  <div className="file-list-header">
                    {tr(
                      `已选择 ${files.length} 个文件 (${totalChars.toLocaleString()} 字)`,
                      `Selected ${files.length} files (${totalChars.toLocaleString()} chars)`
                    )}
                  </div>
                  <div className="file-list-items">
                    {files.slice(0, 10).map((f, i) => (
                      <div key={i} className="file-list-item">
                        <span>#{f.number}</span>
                        <span className="file-title">{f.title}</span>
                        <span>{lang === 'en'
                          ? `${f.content.length.toLocaleString()} chars`
                          : `${f.content.length.toLocaleString()} 字`}
                        </span>
                      </div>
                    ))}
                    {files.length > 10 && (
                      <div className="file-list-more">
                        {tr(
                          `... 还有 ${files.length - 10} 个文件`,
                          `... plus ${files.length - 10} more files`
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="auto-split-toggle">
              <div>
                <h4>{tr('自动拆分章节', 'Auto split chapters')}</h4>
                <p>
                  {autoSplit
                    ? tr('上传单个文件时自动识别章节', 'When uploading a single file, auto-detect chapters')
                    : tr('每个文件作为一章', 'Each file is treated as one chapter')}
                </p>
              </div>
              <button onClick={() => setAutoSplit(!autoSplit)} className={`toggle-btn ${autoSplit ? 'active' : ''}`}>
                <span className="toggle-knob" />
              </button>
            </div>

            <div className="auto-split-toggle">
              <div>
                <h4>{tr('启用角色改名流水线', 'Enable character renaming')}</h4>
                <p>
                  {remapCharacters
                    ? tr('在生成后统一按映射表替换角色名字', 'After generation, automatically apply the character map to rename characters')
                    : tr('直接使用原始名字，不做统一改名', 'Use original names without the rename pipeline')}
                </p>
              </div>
              <button onClick={() => setRemapCharacters(!remapCharacters)} className={`toggle-btn ${remapCharacters ? 'active' : ''}`}>
                <span className="toggle-knob" />
              </button>
            </div>

            <button onClick={handleUpload} disabled={loading || files.length === 0} className="btn btn-primary btn-lg">
              {loading
                ? tr('处理中...', 'Processing...')
                : tr(`🚀 开始处理 (${files.length} 个文件)`, `🚀 Start processing (${files.length} files)`)}
            </button>
          </div>
        )}

        {/* SPLIT PREVIEW */}
        {step === 'split-preview' && splitPreview && (
          <div className="split-preview-view">
            <div className="split-preview-header">
              <h2>{tr('📝 章节拆分预览', '📝 Chapter Split Preview')}</h2>
              <div className="split-preview-meta">
                <span className={`lang-badge ${splitPreview.detectedLanguage}`}>
                  {splitPreview.detectedLanguage === 'cn' ? '中文' :
                    splitPreview.detectedLanguage === 'en' ? 'English' : 'Mixed'}
                </span>
                <span>
                  {(() => {
                    const remaining = splitPreview.chapters.filter((_, i) => !deletedChapterIndices.has(i));
                    const totalChars = remaining.reduce((sum, ch) => sum + ch.contentLength, 0);
                    return tr(
                      `共 ${remaining.length} 章 · ${totalChars.toLocaleString()} 字`,
                      `${remaining.length} chapters · ${totalChars.toLocaleString()} chars`
                    );
                  })()}
                </span>
                {deletedChapterIndices.size > 0 && (
                  <span style={{ color: 'var(--gray-400)', fontSize: '0.875rem' }}>
                    ({tr(`已删除 ${deletedChapterIndices.size} 章`, `${deletedChapterIndices.size} deleted`)})
                  </span>
                )}
              </div>
            </div>

            {splitPreview.chapters.filter((_, i) => !deletedChapterIndices.has(i)).length === 1 && (
              <div className="split-warning">
                ⚠️ {tr(
                  '仅保留 1 个章节，可能章节标记格式不被识别。',
                  'Only 1 chapter remaining. Chapter markers may not be recognized.'
                )}
              </div>
            )}

            <div className="split-chapter-list">
              {splitPreview.chapters.map((ch, i) => {
                const isDeleted = deletedChapterIndices.has(i);
                if (isDeleted) return null;
                return (
                  <div key={i} className="split-chapter-item">
                    <span className="chapter-num">
                      {ch.number > 0 ? `#${ch.number}` : tr('序', 'Prologue')}
                    </span>
                    <span
                      className="chapter-title clickable"
                      onClick={() => setPreviewingChapterIdx(i)}
                      title={tr('点击预览', 'Click to preview')}
                    >
                      {ch.title || tr('(无标题)', '(Untitled)')}
                    </span>
                    <span className="chapter-length">
                      {ch.contentLength.toLocaleString()} {tr('字', 'chars')}
                    </span>
                    <button
                      className="chapter-delete-btn"
                      onClick={() => setDeletedChapterIndices(prev => new Set([...prev, i]))}
                      title={tr('删除此章节', 'Delete this chapter')}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {deletedChapterIndices.size > 0 && (
              <button
                onClick={() => setDeletedChapterIndices(new Set())}
                className="btn btn-ghost"
                style={{ alignSelf: 'center', fontSize: '0.875rem' }}
              >
                {tr('↩ 恢复所有已删除章节', '↩ Restore all deleted chapters')}
              </button>
            )}

            <div className="split-preview-actions">
              <button onClick={handleCancelSplit} className="btn btn-ghost">
                {tr('← 返回修改', '← Go back')}
              </button>
              <button
                onClick={handleConfirmSplit}
                disabled={loading || splitPreview.chapters.filter((_, i) => !deletedChapterIndices.has(i)).length === 0}
                className="btn btn-primary btn-lg"
              >
                {loading
                  ? tr('处理中...', 'Processing...')
                  : tr('✅ 确认并开始索引', '✅ Confirm and start indexing')}
              </button>
            </div>

            {/* Chapter Preview Modal */}
            {previewingChapterIdx !== null && splitPreview && (
              <div className="chapter-preview-modal-overlay" onClick={() => setPreviewingChapterIdx(null)}>
                <div className="chapter-preview-modal" onClick={e => e.stopPropagation()}>
                  <div className="modal-header">
                    <h3>
                      {splitPreview.chapters[previewingChapterIdx]?.title || tr('章节预览', 'Chapter Preview')}
                    </h3>
                    <button onClick={() => setPreviewingChapterIdx(null)}>×</button>
                  </div>
                  <div className="modal-content">
                    {(() => {
                      const ch = splitPreview.chapters[previewingChapterIdx];
                      if (!ch) return tr('无内容', 'No content');
                      return (
                        <>
                          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                            {ch.contentPreview}
                            {ch.contentLength > 2000 && '\n\n...'}
                          </pre>
                          <p style={{ color: 'var(--gray-400)', marginTop: '1rem', fontSize: '0.875rem' }}>
                            {ch.contentLength > 2000
                              ? tr(`显示前 2000 字，共 ${ch.contentLength.toLocaleString()} 字`,
                                `Showing first 2000 chars of ${ch.contentLength.toLocaleString()}`)
                              : tr(`全文 ${ch.contentLength.toLocaleString()} 字`,
                                `Full content: ${ch.contentLength.toLocaleString()} chars`)}
                          </p>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* INDEXING */}
        {step === 'indexing' && (
          <div className="processing-view">
            <h2>{tr('🔍 正在索引...', '🔍 Indexing...')}</h2>
            <p>{tr(`分析 ${chapterCount} 个章节`, `Analyzing ${chapterCount} chapters`)}</p>
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            <p className="progress-text">{progress}% - {progressMessage}</p>
            <div className="log-console">
              {logs.slice(0, 8).map((l, i) => (
                <div key={i} className={`log-entry log-${l.type}`}>
                  <span className="log-time">[{l.timestamp}]</span> {l.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PLANNING */}
        {step === 'planning' && (
          <div className="planning-view">
            <div className="planning-header">
              <h2>{tr('📋 事件规划', '📋 Event Planning')}</h2>
              <p>
                {tr(
                  `共 ${events.length} 个事件节点`,
                  `${events.length} event nodes`
                )}
                {isPlanning && (
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem', color: 'var(--gray-500)' }}>
                    {tr('（正在规划中...）', '(planning...)')}
                  </span>
                )}
              </p>
              {planStats && (
                <p style={{ fontSize: '0.85rem', color: 'var(--gray-600)' }}>
                  {tr('模型推荐', 'Model recommended')}: {planStats.recommended ?? '—'}
                  <span style={{ margin: '0 0.5rem' }}>|</span>
                  {tr('实际生成', 'Actual')}: {planStats.actual ?? '—'}
                  <span style={{ margin: '0 0.5rem' }}>|</span>
                  {tr('你指定', 'Your target')}: {planStats.user ?? '—'}
                </p>
              )}
            </div>

            {/* Character map editor */}
            <div
              className="character-map-panel"
              style={{
                marginTop: '0.75rem',
                marginBottom: '0.75rem',
                padding: '0.75rem 0.85rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--gray-200)',
                background: '#f9fafb',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.25rem' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                  {tr('角色映射（原名 → 新名）', 'Character mapping (original → new)')}
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--gray-500)', borderRadius: '999px', padding: '0.05rem 0.5rem', border: '1px solid var(--gray-200)', background: 'white' }}>
                  {tr('共 ', 'Total ')}{Object.keys(characterMap).length}{tr(' 条', ' mappings')}
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--gray-500)', marginBottom: '0.5rem' }}>
                {tr('索引阶段自动生成的角色改名规则，可在此微调。', 'Auto-generated rename rules from indexing; you can tweak them here.')}
              </p>
              <div style={{ maxHeight: '190px', overflowY: 'auto', borderRadius: '0.35rem', border: '1px solid var(--gray-200)', padding: '0.5rem', background: 'white' }}>
                {Object.keys(characterMap).length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: 'var(--gray-400)' }}>
                    {tr('暂无角色映射，可能索引阶段未识别到角色。', 'No character mappings yet; indexing may not have detected characters.')}
                  </div>
                ) : (
                  Object.entries(characterMap).map(([from, to]) => (
                    <div
                      key={from}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 0.45fr) auto minmax(0, 1fr)',
                        alignItems: 'center',
                        columnGap: '0.35rem',
                        marginBottom: '0.25rem',
                      }}
                    >
                      <span style={{ fontSize: '0.8rem', color: 'var(--gray-600)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{from}</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--gray-400)', textAlign: 'center' }}>→</span>
                      <input
                        value={to}
                        onChange={(e) => {
                          const value = e.target.value;
                          setCharacterMap(prev => ({ ...prev, [from]: value }));
                        }}
                        style={{
                          width: '100%',
                          padding: '0.15rem 0.25rem',
                          fontSize: '0.8rem',
                          border: '1px solid var(--gray-200)',
                          borderRadius: '0.25rem',
                        }}
                      />
                    </div>
                  ))
                )}
              </div>
              <button
                onClick={async () => {
                  if (!sessionId) return;
                  setError(null);
                  try {
                    const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ characterMap }),
                    });
                    if (!res.ok) {
                      const data = await res.json();
                      throw new Error(data.error || tr('保存角色映射失败', 'Failed to save character map'));
                    }
                    addLog('log', tr('已保存角色映射', 'Character map saved'));
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
                className="btn btn-ghost"
                style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
              >
                {tr('💾 保存角色映射', '💾 Save character map')}
              </button>
            </div>

            {/* Mode Selection */}
            <div className="plan-controls">
              <div className="mode-selector">
                <label>{tr('规划模式', 'Planning mode')}</label>
                <div className="mode-tabs">
                  {(['auto', 'split', 'merge', 'one_to_one'] as PlanMode[]).map(m => (
                    <button key={m} className={`mode-tab ${planMode === m ? 'active' : ''}`}
                      onClick={() => setPlanMode(m)}>
                      {m === 'auto'
                        ? tr('🤖 自动', '🤖 Auto')
                        : m === 'split'
                          ? tr('✂️ 拆分', '✂️ Split')
                          : m === 'merge'
                            ? tr('🔗 合并', '🔗 Merge')
                            : tr('1:1 映射', '1:1 Mapping')}
                    </button>
                  ))}
                </div>
              </div>

              <div className="node-count-control">
                <label>{tr('目标节点数', 'Target node count')}</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input type="number" min={1} max={chapterCount * 3 || 999}
                    disabled={planMode === 'one_to_one'}
                    value={targetNodeCount || ''}
                    onChange={(e) => setTargetNodeCount(Number(e.target.value) || 0)}
                    style={{ width: '80px', padding: '0.25rem' }} />
                  {planMode === 'auto' && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
                      {tr('（留空或 0 表示使用系统推荐值）', '(empty or 0 = use system recommendation)')}
                    </span>
                  )}
                </div>
              </div>

              <div className="instructions-control">
                <label>{lang === 'en' ? 'Custom Instructions' : '自定义指令'}</label>
                <textarea placeholder={lang === 'en' ? 'Add extra instructions...' : '添加额外的规划指令...'}
                  value={customInstructions} onChange={(e) => setCustomInstructions(e.target.value)}
                  className="textarea compact" rows={1} style={{ minHeight: '40px', fontSize: '0.9rem' }} />
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <button onClick={handleRerollPlan} disabled={loading || isPlanning} className="btn btn-ghost">
                  {tr('🎲 重新规划', '🎲 Re-plan')}
                </button>
                <button
                  onClick={handleAdjustPlan}
                  disabled={loading || isPlanning || isAdjustingPlan || events.length === 0}
                  className="btn btn-ghost"
                >
                  {isAdjustingPlan
                    ? tr('🦋 微调中...', '🦋 Adjusting...')
                    : tr('🦋 蝴蝶效应微调', '🦋 Butterfly tweak')}
                </button>
              </div>
            </div>

            {/* Events List */}
            <div className="events-list">
              {events.map((event) => (
                <div key={event.id} className={`event-card ${event.type} ${editingEvent === event.id ? 'editing' : ''}`}>
                  <div className="event-header">
                    <span className="event-id">#{event.id}</span>
                    <span className={`event-type ${event.type}`}>
                      {event.type === 'highlight'
                        ? tr('🌟 高光', '🌟 Highlight')
                        : tr('📄 日常', '📄 Normal')}
                    </span>
                    <span className="event-range">
                      {lang === 'en'
                        ? `Ch.${event.startChapter}-${event.endChapter}`
                        : `第${event.startChapter}-${event.endChapter}章`}
                    </span>
                    <div className="event-actions">
                      <button onClick={() => setEditingEvent(editingEvent === event.id ? null : event.id)}>✏️</button>
                      <button onClick={() => handleDeleteEvent(event.id)}>🗑️</button>
                    </div>
                  </div>

                  {editingEvent === event.id ? (
                    <div className="event-edit">
                      <select value={event.type} onChange={(e) => handleUpdateEvent(event.id, 'type', e.target.value)}>
                        <option value="highlight">{tr('高光', 'Highlight')}</option>
                        <option value="normal">{tr('日常', 'Normal')}</option>
                      </select>
                      <input type="number" value={event.startChapter} min={1}
                        onChange={(e) => handleUpdateEvent(event.id, 'startChapter', Number(e.target.value))} />
                      <span>-</span>
                      <input type="number" value={event.endChapter}
                        onChange={(e) => handleUpdateEvent(event.id, 'endChapter', Number(e.target.value))} />
                      <textarea value={event.description}
                        onChange={(e) => handleUpdateEvent(event.id, 'description', e.target.value)} />
                    </div>
                  ) : (
                    <p className="event-desc">{event.description}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="planning-actions">
              <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="autoReview" checked={autoReview} onChange={(e) => setAutoReview(e.target.checked)} />
                <label htmlFor="autoReview">
                  {lang === 'en'
                    ? 'Enable Auto-Review & Re-roll'
                    : '启用自动审查 & 修正 (Auto-Review & Re-roll)'}
                </label>
              </div>
              <button onClick={handleConfirmAndGenerate} className="btn btn-primary btn-lg" disabled={loading || events.length === 0}>
                {tr('✅ 确认并开始生成', '✅ Confirm and start generation')}
              </button>
            </div>
          </div>
        )}

        {/* AGENT IDE (Unified Executing View) */}
        {(step === 'executing' || step === 'branching') && (
          <div className="ide-view" style={{ display: 'grid', gridTemplateColumns: '250px 1fr 300px', gap: '1rem', height: 'calc(100vh - 140px)', padding: '1rem' }}>

          {/* Left: Node List */}
          <div className="ide-sidebar" style={{ background: 'white', borderRadius: '0.5rem', border: '1px solid var(--gray-200)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--gray-200)', fontWeight: '600', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{tr('节点列表', 'Node list')} ({completedNodes}/{nodes.length})</span>
              <div style={{ display: 'flex', gap: '0.25rem', padding: '0.1rem', borderRadius: '999px', background: '#eef2ff' }}>
                <button
                  className={`btn-tab ${nodeViewMode === 'main' ? 'active' : ''}`}
                  onClick={() => setNodeViewMode('main')}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.15rem 0.6rem',
                    borderRadius: '999px',
                    border: 'none',
                    background: nodeViewMode === 'main' ? 'white' : 'transparent',
                    color: nodeViewMode === 'main' ? '#111827' : '#6b7280',
                  }}
                >
                  {tr('主线', 'Main')}
                </button>
                <button
                  className={`btn-tab ${nodeViewMode === 'branch' ? 'active' : ''}`}
                  onClick={() => setNodeViewMode('branch')}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.15rem 0.6rem',
                    borderRadius: '999px',
                    border: 'none',
                    background: nodeViewMode === 'branch' ? 'white' : 'transparent',
                    color: nodeViewMode === 'branch' ? '#111827' : '#6b7280',
                  }}
                >
                  {tr('支线', 'Branch')}
                </button>
              </div>
            </div>
            <div className="node-list">
              {nodes
                .filter(node => (nodeViewMode === 'main' ? !node.branchKind : !!node.branchKind))
                .map(node => {
                  const isBranch = !!node.branchKind;
                  const icon = isBranch
                    ? node.branchKind === 'divergent'
                      ? '🧬'
                      : '🌿'
                    : node.type === 'highlight'
                      ? '🌟'
                      : '📄';

                  return (
                    <div
                      key={node.id}
                      className={`exec-node ${node.status} ${selectedNodeId === node.id ? 'selected' : ''}`}
                      onClick={() => setSelectedNodeId(node.id)}
                      style={{
                        padding: '0.75rem',
                        borderBottom: '1px solid var(--gray-100)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        background:
                          selectedNodeId === node.id
                            ? '#eff6ff'
                            : node.status === 'generating'
                              ? '#fef3c7'
                              : 'white',
                      }}
                    >
                      <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>#{node.id}</span>
                      <span
                        style={{
                          flex: 1,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          fontSize: '0.85rem',
                        }}
                      >
                        {icon} {node.description.slice(0, 10)}
                        {isBranch && node.parentNodeId && (
                          <span
                            style={{
                              marginLeft: '0.25rem',
                              fontSize: '0.7rem',
                              color: 'var(--gray-400)',
                            }}
                          >
                            {node.branchKind === 'convergent'
                              ? tr(
                                  `支线 ${node.parentNodeId}→${node.returnToNodeId ?? '?'}`,
                                  `Br ${node.parentNodeId}→${node.returnToNodeId ?? '?'}`,
                                )
                              : tr(`分支自 #${node.parentNodeId}`, `from #${node.parentNodeId}`)}
                          </span>
                        )}
                      </span>
                      {typeof node.qualityScore === 'number' && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--gray-400)' }}>★{node.qualityScore}</span>
                      )}
                      <span>
                        {node.status === 'completed'
                          ? '✅'
                          : node.status === 'generating'
                            ? '⏳'
                            : '○'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Center: Editor */}
            <div className="ide-editor" style={{ background: 'white', borderRadius: '0.5rem', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {selectedNode ? (
                <>
                  <div className="editor-toolbar" style={{ padding: '0.75rem', borderBottom: '1px solid var(--gray-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>
                        {tr('节点', 'Node')} #{selectedNode.id}
                      </span>
                      <span className={`badge ${selectedNode.type}`} style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', borderRadius: '99px', background: selectedNode.type === 'highlight' ? '#fef3c7' : '#f3f4f6' }}>
                        {selectedNode.type === 'highlight'
                          ? tr('高光', 'Highlight')
                          : tr('日常', 'Normal')}
                      </span>
                      {typeof selectedNode.qualityScore === 'number' && (
                        <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
                          {tr('评分', 'Score')}: {selectedNode.qualityScore}/5
                        </span>
                      )}
                      <span style={{ fontSize: '0.8rem', color: 'var(--gray-500)' }}>
                        {selectedNode.status === 'completed'
                          ? tr('已完成', 'Completed')
                          : selectedNode.status === 'generating'
                            ? tr('生成中...', 'Generating...')
                            : tr('待生成', 'Pending')}
                      </span>
                    </div>
                    <div>
                      {selectedNode.status === 'completed' && (
                        <button onClick={() => handleRerollNode(selectedNode.id)} className="btn btn-ghost btn-sm">
                          {tr('🎲 重生成', '🎲 Regenerate')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="editor-content" style={{ flex: 1, position: 'relative' }}>
                    {selectedNode.status === 'generating' ? (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--gray-400)' }}>
                        <div className="generating-spinner" style={{ fontSize: '2rem', marginBottom: '1rem', animation: 'spin 1s linear infinite' }}>⏳</div>
                        <p>{tr('AI 正在撰写中...', 'AI is writing...')}</p>
                        <p style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
                          {tr('请关注右侧思考流', 'Watch the thought stream on the right')}
                        </p>
                      </div>
                    ) : selectedNode.status === 'completed' ? (
                      <textarea
                        value={selectedNode.content || ''}
                        onChange={(e) => {
                          const newContent = e.target.value;
                          setNodes(prev => prev.map(n => n.id === selectedNode.id ? { ...n, content: newContent } : n));
                        }}
                        style={{ width: '100%', height: '100%', border: 'none', padding: '1rem', resize: 'none', fontSize: '1rem', lineHeight: '1.6', fontFamily: 'system-ui' }}
                        placeholder={tr('在此处编辑内容...', 'Edit content here...')}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--gray-400)' }}>
                        {tr('等待生成...', 'Waiting for generation...')}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--gray-400)' }}>
                  {tr('👈 请从左侧选择一个节点', '👈 Select a node from the left')}
                </div>
              )}
            </div>

            {/* Right: Thought Stream & Status */}
            <div className="ide-status" style={{ background: 'white', borderRadius: '0.5rem', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--gray-200)', fontWeight: '600', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{tr('Agent 状态', 'Agent Status')}</span>
                <span style={{ fontSize: '0.75rem', color: isPaused ? 'orange' : 'green' }}>
                  {isPaused
                    ? tr('⏸ 已暂停', '⏸ Paused')
                    : tr('▶ 运行中', '▶ Running')}
                </span>
              </div>

              <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--gray-200)', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input type="checkbox" checked={autoReview} onChange={(e) => setAutoReview(e.target.checked)} id="ar-toggle" />
                  <label htmlFor="ar-toggle">Auto-Review</label>
                </div>
                {!autoReview && (
                  <button
                    onClick={handleBatchReview}
                    className="btn-sm"
                    style={{ border: '1px solid var(--gray-300)', borderRadius: '4px', background: isBatchReviewing ? '#e5e7eb' : 'white', fontSize: '0.75rem' }}
                    disabled={isBatchReviewing}
                  >
                    {isBatchReviewing ? 'Review 中...' : '全部 Review + 重roll'}
                  </button>
                )}
              </div>

              <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--gray-200)' }}>
                <div style={{ fontSize: '0.8rem', marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{tr('总进度', 'Overall progress')}</span>
                  <span>{Math.round((completedNodes / nodes.length) * 100)}%</span>
                </div>
                <div className="progress-bar" style={{ marginBottom: 0 }}>
                  <div className="progress-fill" style={{ width: `${(completedNodes / nodes.length) * 100}%` }} />
                </div>
              </div>

              <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--gray-200)', display: 'flex', gap: '0.5rem' }}>
                {!isPaused ? (
                  <button onClick={handlePause} className="btn-sm" style={{ flex: 1, border: '1px solid var(--gray-300)', borderRadius: '4px', background: 'white' }}>
                    {tr('⏸ 暂停任务', '⏸ Pause task')}
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                    <input
                      type="text"
                      placeholder={tr('注入下一步指令...', 'Inject next-step instruction...')}
                      value={nextStepInstruction} onChange={(e) => setNextStepInstruction(e.target.value)}
                      style={{ padding: '0.25rem', border: '1px solid var(--gray-300)', borderRadius: '4px' }} />
                    <button
                      onClick={handleResume}
                      className="btn-sm"
                      style={{ background: 'var(--primary)', color: 'white', border: 'none', borderRadius: '4px', padding: '0.4rem' }}
                    >
                      {tr('▶ 继续执行', '▶ Resume')}
                    </button>
                  </div>
                )}
              </div>

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 0.75rem', background: '#f8fafc', borderBottom: '1px solid var(--gray-100)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--gray-600)' }}>
                  {lang === 'en' ? 'Thought Stream' : '思考流 (Thought Stream)'}
                </div>
                <div className="thoughts" ref={thoughtsRef} style={{ flex: 1, padding: '0.75rem', overflowY: 'auto', background: '#1e293b', color: '#a78bfa', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                  {thoughts.length === 0 ? (
                    <span style={{ color: 'var(--gray-500)' }}>{tr('等待思考...', 'Waiting for thoughts...')}</span>
                  ) : (
                    thoughts.map((t, i) => <p key={i} style={{ marginBottom: '0.25rem' }}>{t}</p>)
                  )}
                </div>

                {/* Review results list */}
                <div style={{ padding: '0.5rem 0.75rem', background: '#f9fafb', borderTop: '1px solid var(--gray-200)', maxHeight: '180px', overflowY: 'auto' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                    {tr('Review 结果', 'Review Results')}
                  </div>
                  {reviewResults.length === 0 ? (
                    <div style={{ fontSize: '0.75rem', color: 'var(--gray-500)' }}>
                      {tr('暂无审稿结果', 'No review results yet')}
                    </div>
                  ) : (
                    reviewResults.map(r => (
                      <div key={r.nodeId} style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                        <span>
                          {tr('节点', 'Node')} #{r.nodeId}: {tr('评分', 'Score')} {r.score}/5
                        </span>
                        {r.issues.length > 0 && (
                          <div style={{ marginLeft: '0.5rem', color: 'var(--gray-500)' }}>
                            {tr('问题', 'Issues')}: {r.issues.join(lang === 'en' ? '; ' : '；')}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
