import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowDownUp, ArrowUpRight, Check, ChevronDown, Clock3, Code2, Eye, Gauge, GripVertical, LayoutDashboard, ListFilter, Pencil, Plus, Radio, Settings2, Signal, SlidersHorizontal, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import { getHealthCheckQueryKey, useGetTelemetrySnapshot, useHealthCheck, type TelemetrySnapshot, type TelemetrySource } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

type WidgetType = 'metric' | 'trend' | 'gauge' | 'status' | 'events';
type DashboardWidget = {
  id: string;
  type: WidgetType;
  sourceKey: string;
  title: string;
  columnSpan: number;
  rowSpan: number;
};
type SocketState = 'connecting' | 'live' | 'reconnecting';
type LiveEvent = { id: string; key: string; label: string; value: number; unit: string; at: Date };
type SourcePatch = { key: string; value: number; status?: TelemetrySource['status']; history?: number[]; label?: string; unit?: string; min?: number; max?: number };

const queryClient = new QueryClient();
const STORAGE_KEY = 'signalboard-layout-v1';
const widgetOptions: { type: WidgetType; label: string; description: string; icon: typeof Activity }[] = [
  { type: 'metric', label: 'Value', description: 'A precise latest reading', icon: Signal },
  { type: 'trend', label: 'Trend', description: 'History, at a glance', icon: Activity },
  { type: 'gauge', label: 'Gauge', description: 'Position within a range', icon: Gauge },
  { type: 'status', label: 'Status', description: 'Health of a source', icon: Radio },
  { type: 'events', label: 'Events', description: 'Recent live updates', icon: Clock3 },
];

function makeId() {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function readStoredWidgets(): DashboardWidget[] | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is DashboardWidget =>
      !!item && typeof item.id === 'string' && ['metric', 'trend', 'gauge', 'status', 'events'].includes(item.type) &&
      typeof item.sourceKey === 'string' && typeof item.title === 'string' &&
      Number.isFinite(item.columnSpan) && Number.isFinite(item.rowSpan),
    );
  } catch {
    return null;
  }
}

function mapSocketUpdate(input: unknown): SourcePatch[] {
  if (Array.isArray(input)) return input.flatMap(mapSocketUpdate);
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.updates)) return record.updates.flatMap(mapSocketUpdate);
  const nested = record.source && typeof record.source === 'object' ? record.source as Record<string, unknown> : null;
  const envelope = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : null;
  const payload = nested ?? envelope ?? record;
  const keyValue = payload.key ?? payload.sourceKey ?? record.key ?? record.sourceKey;
  const reading = payload.value ?? payload.reading ?? record.value ?? record.reading;
  if (typeof keyValue !== 'string' || typeof reading !== 'number' || !Number.isFinite(reading)) return [];
  const patch: SourcePatch = { key: keyValue, value: reading };
  if (payload.status === 'active' || payload.status === 'warning' || payload.status === 'idle') patch.status = payload.status;
  if (Array.isArray(payload.history) && payload.history.every((item) => typeof item === 'number')) patch.history = payload.history as number[];
  if (typeof payload.label === 'string') patch.label = payload.label;
  if (typeof payload.unit === 'string') patch.unit = payload.unit;
  if (typeof payload.min === 'number') patch.min = payload.min;
  if (typeof payload.max === 'number') patch.max = payload.max;
  return [patch];
}

function useTelemetrySocket(onUpdates: (updates: SourcePatch[]) => void) {
  const [state, setState] = useState<SocketState>('connecting');
  const callbackRef = useRef(onUpdates);
  callbackRef.current = onUpdates;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer = 0;
    let disposed = false;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      setState(attempts === 0 ? 'connecting' : 'reconnecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      socket.onopen = () => {
        attempts = 0;
        setState('live');
      };
      socket.onmessage = (event) => {
        try {
          callbackRef.current(mapSocketUpdate(JSON.parse(String(event.data))));
        } catch {
          // Ignore malformed frames; a later valid update keeps the stream useful.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setState('reconnecting');
        attempts += 1;
        retryTimer = window.setTimeout(connect, Math.min(12000, 650 * (2 ** Math.min(attempts - 1, 4))));
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return state;
}

function seededLayout(sources: TelemetrySource[]): DashboardWidget[] {
  if (!sources.length) return [];
  const types: WidgetType[] = ['metric', 'trend', 'gauge', 'status', 'metric', 'events'];
  return types.map((type, index) => {
    const source = sources[index % sources.length];
    return {
      id: `starter-${index}-${source.key}`,
      type,
      sourceKey: source.key,
      title: type === 'events' ? 'Live updates' : source.label,
      columnSpan: type === 'trend' || type === 'events' ? 2 : 1,
      rowSpan: type === 'trend' || type === 'events' ? 2 : 1,
    };
  });
}

function formatValue(value: number, unit: string) {
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${number} ${unit}` : number;
}

function timeLabel(date: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function Sparkline({ history, warning = false, sourceKey }: { history: number[]; warning?: boolean; sourceKey: string }) {
  if (history.length < 2) return <div className="chart-empty" data-testid={`text-history-awaiting-${sourceKey}`}>Awaiting more readings</div>;
  const points = history;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coordinates = points.map((value, index) => `${(index / (points.length - 1)) * 100},${42 - ((value - min) / range) * 34}`).join(' ');
  const color = warning ? '#cf7956' : '#368d77';
  return (
    <svg className="sparkline" viewBox="0 0 100 48" preserveAspectRatio="none" aria-label="Recent source history">
      <line x1="0" y1="42" x2="100" y2="42" stroke="currentColor" strokeDasharray="2 4" opacity=".22" />
      <polyline points={coordinates} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy={coordinates.split(' ').at(-1)?.split(',')[1] ?? 8} r="2.8" fill={color} />
    </svg>
  );
}

function GaugeVisual({ source }: { source: TelemetrySource }) {
  const ratio = Math.max(0, Math.min(1, (source.value - source.min) / (source.max - source.min || 1)));
  const circumference = 138.2;
  const offset = circumference * (1 - ratio);
  return (
    <div className="gauge-visual" data-testid={`gauge-reading-${source.key}`}>
      <svg viewBox="0 0 120 74" role="img" aria-label={`Gauge at ${Math.round(ratio * 100)} percent`}>
        <path d="M13 62a47 47 0 0 1 94 0" fill="none" stroke="var(--gauge-track)" strokeWidth="8" strokeLinecap="round" pathLength={circumference} />
        <path d="M13 62a47 47 0 0 1 94 0" fill="none" stroke={source.status === 'warning' ? '#c87856' : '#368d77'} strokeWidth="8" strokeLinecap="round" pathLength={circumference} strokeDasharray={circumference} strokeDashoffset={offset} />
      </svg>
      <div className="gauge-number"><strong>{formatValue(source.value, source.unit)}</strong><span>{Math.round(ratio * 100)}% of range</span></div>
      <div className="gauge-limits"><span>{formatValue(source.min, source.unit)}</span><span>{formatValue(source.max, source.unit)}</span></div>
    </div>
  );
}

function WidgetContent({ widget, source, events }: { widget: DashboardWidget; source?: TelemetrySource; events: LiveEvent[] }) {
  if (widget.type === 'events') {
    return (
      <div className="event-feed" data-testid={`events-feed-${widget.id}`}>
        {events.length ? events.slice(0, 5).map((event) => (
          <div className="event-row" key={event.id} data-testid={`event-item-${event.id}`}>
            <span className="event-bead" />
            <div className="event-copy"><strong>{event.label}</strong><span>{formatValue(event.value, event.unit)}</span></div>
            <time>{timeLabel(event.at)}</time>
          </div>
        )) : (
          <div className="awaiting-events"><span className="event-bead" /><div><strong>Listening for source changes</strong><small>New readings will appear here as they arrive.</small></div></div>
        )}
      </div>
    );
  }
  if (!source) {
    return <div className="missing-source" data-testid={`empty-source-${widget.id}`}><AlertTriangle size={16} /><span>Source unavailable</span><small>Choose another source in layout edit mode.</small></div>;
  }
  if (widget.type === 'metric') {
    const recent = source.history;
    const previous = recent.length > 1 ? recent[recent.length - 2] : source.value;
    const diff = source.value - previous;
    return (
      <div className="metric-content" data-testid={`metric-reading-${source.key}`}>
        <div className="metric-main"><strong>{formatValue(source.value, source.unit)}</strong><span className={`delta ${diff > 0 ? 'positive' : diff < 0 ? 'negative' : ''}`}><ArrowUpRight size={13} />{diff === 0 ? 'unchanged' : `${diff > 0 ? '+' : ''}${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(diff)} ${source.unit}`}</span></div>
        <div className="metric-bottom"><span className="micro-label">LATEST READING</span><div className="metric-spark"><Sparkline history={source.history} warning={source.status === 'warning'} sourceKey={source.key} /></div></div>
      </div>
    );
  }
  if (widget.type === 'trend') {
    return (
      <div className="trend-content" data-testid={`trend-reading-${source.key}`}>
        <div className="trend-top"><strong>{formatValue(source.value, source.unit)}</strong><span><span className={`tiny-state ${source.status}`} />{source.status}</span></div>
        <div className="trend-chart"><Sparkline history={source.history} warning={source.status === 'warning'} sourceKey={source.key} /></div>
        <div className="trend-axis"><span>Earlier</span><span>Now</span></div>
      </div>
    );
  }
  if (widget.type === 'gauge') {
    return <GaugeVisual source={source} />;
  }
  return (
    <div className="status-content" data-testid={`status-reading-${source.key}`}>
      <div className={`status-orbit ${source.status}`}><span /><span /><span /><Radio size={22} /></div>
      <div className="status-text"><strong>{source.status === 'active' ? 'Operating normally' : source.status === 'warning' ? 'Attention required' : 'No recent signal'}</strong><span>Last value <b>{formatValue(source.value, source.unit)}</b></span></div>
      <span className={`status-pill ${source.status}`}><i />{source.status}</span>
    </div>
  );
}

function WidgetCard({
  widget, source, sources, events, editMode, onUpdate, onRemove, onDragStart, onDrop, onMove,
}: {
  widget: DashboardWidget; source?: TelemetrySource; sources: TelemetrySource[]; events: LiveEvent[]; editMode: boolean;
  onUpdate: (id: string, patch: Partial<DashboardWidget>) => void; onRemove: (id: string) => void;
  onDragStart: (id: string) => void; onDrop: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const type = widgetOptions.find((option) => option.type === widget.type);
  const Icon = type?.icon ?? Activity;
  return (
    <article
      className={`widget-card span-${widget.columnSpan} rows-${widget.rowSpan} widget-${widget.type} ${editMode ? 'is-editing' : ''}`}
      data-testid={`widget-card-${widget.id}`}
      draggable={editMode}
      onDragStart={() => onDragStart(widget.id)}
      onDragOver={(event) => { if (editMode) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); onDrop(widget.id); }}
    >
      <header className="widget-head">
        <div className="widget-title-wrap">
          {editMode && <span className="drag-grip" aria-label="Drag to reorder"><GripVertical size={15} /></span>}
          <span className={`widget-icon ${widget.type}`}><Icon size={15} /></span>
          <div><h2 data-testid={`widget-title-${widget.id}`}>{widget.title}</h2><p data-testid={`widget-source-${widget.id}`}>{widget.type === 'events' ? 'STREAM · ALL SOURCES' : source?.key ?? widget.sourceKey}</p></div>
        </div>
        <div className="widget-tools">
          {widget.type !== 'events' && <span className={`source-state ${source?.status ?? 'idle'}`} data-testid={`source-status-${widget.id}`}><i />{source?.status ?? 'offline'}</span>}
          {editMode && <button type="button" className="icon-button" onClick={() => setEditing((value) => !value)} aria-label={`${editing ? 'Close' : 'Edit'} ${widget.title}`} data-testid={`button-edit-widget-${widget.id}`}><Settings2 size={16} /></button>}
        </div>
      </header>
      {editing && !editMode && (
        <div className="widget-mini-menu" data-testid={`widget-menu-${widget.id}`}>
          <button type="button" onClick={() => setEditing(false)}><Eye size={14} /> Keep in view</button>
        </div>
      )}
      {editMode && editing && (
        <div className="widget-editor" data-testid={`widget-editor-${widget.id}`}>
          <label>Widget name<input value={widget.title} onChange={(event) => onUpdate(widget.id, { title: event.target.value })} data-testid={`input-widget-title-${widget.id}`} /></label>
          {widget.type !== 'events' && <label>Data source<select value={widget.sourceKey} onChange={(event) => {
            const nextSource = sources.find((item) => item.key === event.target.value);
            onUpdate(widget.id, { sourceKey: event.target.value, title: widget.title === source?.label && nextSource ? nextSource.label : widget.title });
          }} data-testid={`select-widget-source-${widget.id}`}>{sources.map((item) => <option value={item.key} key={item.key}>{item.label} · {item.key}</option>)}{!sources.some((item) => item.key === widget.sourceKey) && <option value={widget.sourceKey}>{widget.sourceKey} · unavailable</option>}</select></label>}
          <div className="editor-row">
            <span>Footprint</span>
            <div className="segmented-control">
              <button className={widget.columnSpan === 1 ? 'selected' : ''} type="button" onClick={() => onUpdate(widget.id, { columnSpan: 1 })} data-testid={`button-size-compact-${widget.id}`}>Compact</button>
              <button className={widget.columnSpan === 2 ? 'selected' : ''} type="button" onClick={() => onUpdate(widget.id, { columnSpan: 2 })} data-testid={`button-size-wide-${widget.id}`}>Wide</button>
            </div>
          </div>
          <div className="editor-row">
            <span>Height</span>
            <div className="segmented-control">
              <button className={widget.rowSpan === 1 ? 'selected' : ''} type="button" onClick={() => onUpdate(widget.id, { rowSpan: 1 })} data-testid={`button-height-short-${widget.id}`}>Short</button>
              <button className={widget.rowSpan === 2 ? 'selected' : ''} type="button" onClick={() => onUpdate(widget.id, { rowSpan: 2 })} data-testid={`button-height-tall-${widget.id}`}>Tall</button>
            </div>
          </div>
          <div className="editor-actions">
            <button type="button" className="text-action" onClick={() => onMove(widget.id, -1)} data-testid={`button-move-up-${widget.id}`}><ArrowDownUp size={14} /> Move earlier</button>
            <button type="button" className="text-action danger-action" onClick={() => onRemove(widget.id)} data-testid={`button-remove-widget-${widget.id}`}><Trash2 size={14} /> Remove</button>
          </div>
        </div>
      )}
      <div className="widget-content"><WidgetContent widget={widget} source={source} events={events} /></div>
      <footer className="widget-foot"><span>{widget.type === 'events' ? 'LIVE STREAM' : source?.label ?? 'No source'}</span><span className="foot-unit">{widget.type === 'events' ? 'LATEST FIRST' : source?.unit || '—'}</span></footer>
    </article>
  );
}

function AddWidgetPanel({ sources, onAdd, onClose }: { sources: TelemetrySource[]; onAdd: (type: WidgetType, sourceKey: string) => void; onClose: () => void }) {
  const [selectedType, setSelectedType] = useState<WidgetType>('metric');
  const [selectedSource, setSelectedSource] = useState(sources[0]?.key ?? '');
  useEffect(() => {
    if (!sources.some((source) => source.key === selectedSource)) setSelectedSource(sources[0]?.key ?? '');
  }, [sources, selectedSource]);
  const option = widgetOptions.find((item) => item.type === selectedType) ?? widgetOptions[0];
  const Icon = option.icon;
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-widget-title" data-testid="panel-add-widget">
        <header><div><span className="eyebrow">COMPOSE A PANEL</span><h2 id="add-widget-title">Add a widget</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close add widget" data-testid="button-close-add-widget"><X size={18} /></button></header>
        <p className="dialog-subtitle">Choose an instrument, then connect it to a telemetry source.</p>
        <div className="widget-choice-grid">{widgetOptions.map((item) => {
          const ChoiceIcon = item.icon;
          return <button key={item.type} type="button" onClick={() => setSelectedType(item.type)} className={`widget-choice ${selectedType === item.type ? 'selected' : ''}`} data-testid={`button-choose-${item.type}`}><ChoiceIcon size={17} /><strong>{item.label}</strong><span>{item.description}</span>{selectedType === item.type && <Check size={14} className="choice-check" />}</button>;
        })}</div>
        {selectedType !== 'events' && <label className="dialog-select-label">TELEMETRY SOURCE<select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)} data-testid="select-new-widget-source">{sources.length ? sources.map((source) => <option value={source.key} key={source.key}>{source.label} · {source.key}</option>) : <option value="">No sources available</option>}</select></label>}
        <div className="dialog-preview"><span className="preview-icon"><Icon size={17} /></span><div><b>{option.label} instrument</b><span>{selectedType === 'events' ? 'A live stream of source updates' : sources.find((source) => source.key === selectedSource)?.label ?? 'Select a source'}</span></div><span className="preview-live"><i /> LIVE</span></div>
        <footer><button type="button" className="button-quiet" onClick={onClose} data-testid="button-cancel-add-widget">Cancel</button><button type="button" className="button-primary" onClick={() => { onAdd(selectedType, selectedSource); onClose(); }} disabled={selectedType !== 'events' && !sources.length} data-testid="button-confirm-add-widget"><Plus size={15} /> Add to board</button></footer>
      </section>
    </div>
  );
}

function Dashboard() {
  const snapshotQuery = useGetTelemetrySnapshot();
  const healthQuery = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const [widgets, setWidgets] = useState<DashboardWidget[]>(() => readStoredWidgets() ?? []);
  const [hasStoredLayout, setHasStoredLayout] = useState(() => readStoredWidgets() !== null);
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<'board' | 'sources'>('board');
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [liveSources, setLiveSources] = useState<TelemetrySource[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const draggedId = useRef<string | null>(null);
  const initializedSources = useRef(false);
  const pendingUpdates = useRef(new Map<string, SourcePatch>());
  const snapshot = snapshotQuery.data as TelemetrySnapshot | undefined;

  useEffect(() => {
    if (!snapshot?.sources || initializedSources.current) return;
    initializedSources.current = true;
    const initialSources = snapshot.sources.map((source) => {
      const patch = pendingUpdates.current.get(source.key);
      return patch ? { ...source, ...patch, history: patch.history ?? [...source.history.slice(-19), patch.value] } : source;
    });
    setLiveSources(initialSources);
    if (!hasStoredLayout) {
      setWidgets(seededLayout(initialSources));
      setHasStoredLayout(true);
    }
  }, [snapshot, hasStoredLayout]);

  const applyUpdates = useCallback((updates: SourcePatch[]) => {
    if (!updates.length) return;
    updates.forEach((patch) => pendingUpdates.current.set(patch.key, patch));
    setLiveSources((current) => current.map((source) => {
      const patch = updates.find((item) => item.key === source.key);
      if (!patch) return source;
      const history = patch.history ?? [...source.history.slice(-19), patch.value];
      return { ...source, ...patch, history };
    }));
    setEvents((current) => {
      const next = updates.map((patch) => {
        const source = liveSources.find((item) => item.key === patch.key);
        return { id: `${Date.now()}-${patch.key}-${Math.random().toString(36).slice(2, 5)}`, key: patch.key, label: patch.label ?? source?.label ?? patch.key, value: patch.value, unit: patch.unit ?? source?.unit ?? '', at: new Date() };
      });
      return [...next, ...current].slice(0, 30);
    });
  }, [liveSources]);
  const socketState = useTelemetrySocket(applyUpdates);

  useEffect(() => {
    if (!hasStoredLayout) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
    } catch {
      // The dashboard remains usable when browser storage is unavailable.
    }
  }, [widgets, hasStoredLayout]);

  const sources = liveSources.length ? liveSources : snapshot?.sources ?? [];
  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.key, source])), [sources]);
  const filteredSources = useMemo(() => sources.filter((source) => `${source.label} ${source.key} ${source.unit}`.toLowerCase().includes(search.toLowerCase())), [sources, search]);
  const activeCount = sources.filter((source) => source.status === 'active').length;
  const warningCount = sources.filter((source) => source.status === 'warning').length;
  const latestTime = snapshot?.generatedAt ? new Date(snapshot.generatedAt) : null;

  const addWidget = (type: WidgetType, sourceKey: string) => {
    const source = sourceMap.get(sourceKey);
    const option = widgetOptions.find((item) => item.type === type);
    const widget: DashboardWidget = { id: makeId(), type, sourceKey, title: type === 'events' ? 'Live updates' : source?.label ?? option?.label ?? 'New widget', columnSpan: type === 'trend' || type === 'events' ? 2 : 1, rowSpan: type === 'trend' || type === 'events' ? 2 : 1 };
    setWidgets((current) => [...current, widget]);
    setEditMode(true);
  };
  const updateWidget = (id: string, patch: Partial<DashboardWidget>) => setWidgets((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const removeWidget = (id: string) => setWidgets((current) => current.filter((item) => item.id !== id));
  const moveWidget = (id: string, direction: -1 | 1) => setWidgets((current) => {
    const index = current.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const reorderWidgets = (targetId: string) => {
    const from = draggedId.current;
    draggedId.current = null;
    if (!from || from === targetId) return;
    setWidgets((current) => {
      const next = [...current];
      const fromIndex = next.findIndex((item) => item.id === from);
      const targetIndex = next.findIndex((item) => item.id === targetId);
      if (fromIndex < 0 || targetIndex < 0) return current;
      const [item] = next.splice(fromIndex, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-mark"><span /><span /><span /></span><span>signal<span>board</span></span><span className="brand-version">FIELD 01</span></div>
        <div className="workspace-switcher"><div className="workspace-glyph">N</div><div><span>WORKSPACE</span><strong>Northstar systems</strong></div><ChevronDown size={14} /></div>
        <div className="side-section-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button type="button" className={`nav-item ${viewMode === 'board' ? 'active' : ''}`} onClick={() => setViewMode('board')} data-testid="button-nav-dashboard"><LayoutDashboard size={16} /><span>Dashboard</span><kbd>⌘ 1</kbd></button>
          <button type="button" className={`nav-item ${viewMode === 'sources' ? 'active' : ''}`} onClick={() => setViewMode('sources')} data-testid="button-nav-sources"><ListFilter size={16} /><span>Sources</span><span className="nav-count">{sources.length || '—'}</span></button>
        </nav>
        <div className="sidebar-divider" />
        <div className="side-section-label sources-label">LIVE SOURCES <span className={`side-live ${socketState}`}><i />{socketState === 'live' ? 'LIVE' : socketState === 'connecting' ? 'LINKING' : 'RETRY'}</span></div>
        <div className="source-list">
          {sources.length ? sources.slice(0, 7).map((source) => <button type="button" className="source-nav-row" key={source.key} onClick={() => { setViewMode('sources'); setSearch(source.label); }} data-testid={`button-source-${source.key}`}><span className={`source-marker ${source.status}`} /><span>{source.label}</span><small>{source.unit || '—'}</small></button>) : <div className="sidebar-loading"><span /><span /><span /></div>}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-health"><span className={`health-icon ${healthQuery.isError ? 'error' : ''}`}>{healthQuery.isError ? <WifiOff size={15} /> : <Wifi size={15} />}</span><div><strong>{healthQuery.isError ? 'API unreachable' : healthQuery.data?.status === 'ok' ? 'API operational' : 'API status'}</strong><span>{healthQuery.isError ? 'Check your connection' : 'Telemetry service'}</span></div><button type="button" onClick={() => { void healthQuery.refetch(); void snapshotQuery.refetch(); }} aria-label="Refresh service status" data-testid="button-refresh-health"><ArrowDownUp size={14} /></button></div>
          <div className="profile-row"><div className="profile-avatar">SB</div><div><strong>Signal operator</strong><span>Local session</span></div><button type="button" className="icon-button sidebar-settings" aria-label="Toggle layout editor" data-testid="button-toggle-layout-editor" onClick={() => setEditMode((value) => !value)}><Settings2 size={16} /></button></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{viewMode === 'board' ? 'Operations overview' : 'Source catalog'}</strong></div>
          <div className="topbar-right">
            <div className={`connection-state ${socketState}`} data-testid="status-websocket"><span className="connection-dot">{socketState === 'live' ? <Wifi size={13} /> : socketState === 'connecting' ? <Radio size={13} /> : <WifiOff size={13} />}</span><span>{socketState === 'live' ? 'Live connection' : socketState === 'connecting' ? 'Connecting' : 'Reconnecting'}</span><i /></div>
            <span className="topbar-divider" />
            <button type="button" className="top-icon" onClick={() => void snapshotQuery.refetch()} aria-label="Refresh telemetry snapshot" data-testid="button-refresh-snapshot"><ArrowDownUp size={16} /></button>
            <div className="top-avatar" aria-label="Current profile" data-testid="text-current-profile">SO</div>
          </div>
        </header>
        <div className="content-shell">
          <div className="page-heading">
            <div><div className="heading-kicker"><span className="kicker-line" />INSTRUMENT PANEL <span className="heading-sequence">/ 01</span></div><h1>{viewMode === 'board' ? <>Operations <em>overview</em></> : <>Source <em>catalog</em></>}</h1><p>{viewMode === 'board' ? 'A deliberate view of the signals that matter.' : 'Available telemetry, in its raw and useful form.'}</p></div>
            <div className="heading-actions">
              <div className="view-switch" role="group" aria-label="Dashboard display mode">
                <button type="button" className={!editMode ? 'selected' : ''} onClick={() => setEditMode(false)} data-testid="button-view-mode"><Eye size={14} /> View</button>
                <button type="button" className={editMode ? 'selected' : ''} onClick={() => setEditMode(true)} data-testid="button-edit-mode"><Pencil size={14} /> Edit</button>
              </div>
              <button type="button" className="button-primary add-widget-trigger" onClick={() => setShowAdd(true)} data-testid="button-add-widget"><Plus size={16} /> Add widget</button>
            </div>
          </div>

          <section className="summary-strip" aria-label="Dashboard status">
            <div className="summary-live"><span className="summary-live-dot"><i /></span><div><span>STREAM STATUS</span><strong data-testid="text-stream-status">{socketState === 'live' ? 'Receiving live data' : socketState === 'connecting' ? 'Opening connection' : 'Restoring connection'}</strong></div></div>
            <span className="summary-separator" />
            <div className="summary-stat"><span className="summary-icon"><Signal size={15} /></span><div><span>ACTIVE SIGNALS</span><strong data-testid="text-active-signals">{activeCount}<small> / {sources.length}</small></strong></div></div>
            <div className="summary-stat"><span className={`summary-icon ${warningCount ? 'warn' : ''}`}><AlertTriangle size={15} /></span><div><span>NEEDS ATTENTION</span><strong data-testid="text-warning-signals">{warningCount.toString().padStart(2, '0')}</strong></div></div>
            <div className="summary-updated"><span>SNAPSHOT</span><strong data-testid="text-snapshot-time">{latestTime ? latestTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Waiting for data'}</strong></div>
          </section>

          {snapshotQuery.isLoading && <div className="dashboard-skeleton" data-testid="loading-snapshot"><div className="skeleton-card large" /><div className="skeleton-card" /><div className="skeleton-card" /><div className="skeleton-card" /></div>}
          {snapshotQuery.isError && !snapshot && <section className="error-panel" data-testid="error-snapshot"><div className="error-symbol"><WifiOff size={20} /></div><div><strong>Telemetry snapshot unavailable</strong><p>The board will connect once the source catalog can be reached.</p></div><button type="button" className="button-quiet" onClick={() => void snapshotQuery.refetch()} data-testid="button-retry-snapshot">Retry connection</button></section>}

          {viewMode === 'board' && !snapshotQuery.isLoading && (!snapshotQuery.isError || widgets.length > 0 || Boolean(snapshot)) && (
            <>
              <div className="board-toolbar">
                <div><span className="board-caption">{editMode ? 'LAYOUT EDITOR' : 'CURRENT BOARD'}</span><span className="widget-total" data-testid="text-widget-count">{widgets.length.toString().padStart(2, '0')} <span>instruments</span></span></div>
                <div className="board-tools">
                  {editMode ? <><span className="edit-hint"><GripVertical size={14} /> Drag to reorder · adjust each footprint</span><button type="button" className="button-quiet save-layout" onClick={() => setEditMode(false)} data-testid="button-finish-edit"><Check size={14} /> Done editing</button></> : <><span className="board-freshness"><span className="freshness-dot" /> {socketState === 'live' ? 'UPDATING LIVE' : 'WAITING FOR STREAM'}</span><button type="button" className="toolbar-more" onClick={() => setEditMode(true)} aria-label="Open board layout editor" data-testid="button-open-layout-editor"><SlidersHorizontal size={16} /></button></>}
                </div>
              </div>
              {widgets.length ? <div className="widget-grid" data-testid="dashboard-widget-grid">{widgets.map((widget) => <WidgetCard key={widget.id} widget={widget} source={sourceMap.get(widget.sourceKey)} sources={sources} events={events} editMode={editMode} onUpdate={updateWidget} onRemove={removeWidget} onDragStart={(id) => { draggedId.current = id; }} onDrop={reorderWidgets} onMove={moveWidget} />)}</div> : <section className="empty-board" data-testid="empty-dashboard"><div className="empty-mark"><LayoutDashboard size={22} /></div><span className="eyebrow">A PANEL, YOUR WAY</span><h2>Start with one signal.</h2><p>Add a value, trend, gauge, status, or live event stream to compose your board.</p><button type="button" className="button-primary" onClick={() => setShowAdd(true)} data-testid="button-add-first-widget"><Plus size={15} /> Add your first widget</button></section>}
            </>
          )}

          {viewMode === 'sources' && !snapshotQuery.isLoading && (!snapshotQuery.isError || Boolean(snapshot)) && (
            <section className="catalog-panel" data-testid="source-catalog">
              <div className="catalog-toolbar"><div><span className="board-caption">TELEMETRY REGISTRY</span><span className="widget-total" data-testid="text-source-count">{sources.length.toString().padStart(2, '0')} <span>sources</span></span></div><label className="source-search"><ListFilter size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by name or key" aria-label="Filter telemetry sources" data-testid="input-source-filter" /><kbd>/</kbd></label></div>
              <div className="source-table-head"><span>SOURCE</span><span>KEY</span><span>LATEST VALUE</span><span>STATUS</span><span>RANGE</span><span /></div>
              {filteredSources.length ? filteredSources.map((source, index) => <div className="source-table-row" key={source.key} data-testid={`row-source-${source.key}`}><div className="source-table-name"><span className={`source-marker ${source.status}`} /><span>{source.label}</span></div><code>{source.key}</code><strong data-testid={`source-value-${source.key}`}>{formatValue(source.value, source.unit)}</strong><span className={`table-status ${source.status}`}><i />{source.status}</span><span className="range-cell">{formatValue(source.min, source.unit)} <span>—</span> {formatValue(source.max, source.unit)}</span><button type="button" className="icon-button" onClick={() => { addWidget('metric', source.key); setViewMode('board'); }} aria-label={`Add ${source.label} as a value widget`} data-testid={`button-add-source-${source.key}`}><Plus size={16} /></button></div>) : <div className="catalog-empty" data-testid="empty-source-filter">No sources match this filter.</div>}
              <div className="catalog-footer"><span><span className="footer-live-dot" />Values continue updating over the live stream</span><span>SNAPSHOT CATALOG · READ ONLY</span></div>
            </section>
          )}
          <footer className="page-footer"><span><Code2 size={13} /> SIGNALBOARD / CONTROL SURFACE</span><span>LOCAL LAYOUT <i /> {widgets.length} WIDGETS</span></footer>
        </div>
      </main>
      {showAdd && <AddWidgetPanel sources={sources} onAdd={addWidget} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;