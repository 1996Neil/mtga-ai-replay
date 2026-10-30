import { useEffect, useRef, useState } from 'react';

type Preview = { settings: { retention_days: number | null }; expired_records: number; estimated_replay_bytes: number;
  deleted_records?: number; removed_bundle_copies?: number };
const size = (bytes: number) => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function ReplaySettings() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false), [days, setDays] = useState('30'), [unlimited, setUnlimited] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [result, setResult] = useState('');
  const valid = unlimited || /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 36500;
  async function show() {
    dialog.current?.showModal(); setOpen(true); setError(''); setResult(''); setPreview(null);
    try {
      const response = await fetch('/api/replay-settings', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('设置暂时无法读取，请重试。');
      const value = await response.json() as Preview;
      setUnlimited(value.settings.retention_days === null); setDays(String(value.settings.retention_days ?? 30)); setPreview(value);
    } catch { setError('设置暂时无法读取，请确认服务已更新后重试。'); }
  }
  useEffect(() => {
    if (!open || !valid) { setPreview(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/replay-settings?days=${unlimited ? 'all' : days}`, { cache: 'no-store', signal: controller.signal })
        .then(async response => { if (!response.ok) throw Error(); return response.json() as Promise<Preview>; })
        .then(value => { setPreview(value); setError(''); })
        .catch(() => { if (!controller.signal.aborted) setError('清理预览暂时无法读取，请重试。'); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, days, unlimited, valid]);
  async function save() {
    if (!valid || !preview || busy) return;
    setBusy(true); setError(''); setResult('');
    try {
      const response = await fetch('/api/replay-settings', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MTGA-Replay-Action': 'replay-settings' },
        body: JSON.stringify({ retention_days: unlimited ? null : Number(days) }), signal: AbortSignal.timeout(180000) });
      const value = await response.json();
      if (!response.ok) throw Error(value.error ?? '清理未完成，请重试。');
      setPreview({ ...value, expired_records: 0, estimated_replay_bytes: 0 });
      setResult(`已保存。清理 ${value.deleted_records} 条本地记录、${value.removed_bundle_copies} 份上传暂存，释放约 ${size(value.freed_bytes)}。`);
    } catch { setError('保存或清理未完成，请重新打开设置核对并重试。'); }
    finally { setBusy(false); }
  }
  function close() { if (busy) return; dialog.current?.close(); setOpen(false); }
  return <>
    <button type="button" className="standard-button replay-settings-button" onClick={() => void show()}>设置</button>
    <dialog ref={dialog} className="replay-settings-dialog" aria-labelledby="replay-settings-title"
      onCancel={event => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="settings-heading"><h2 id="replay-settings-title">回放设置</h2><button type="button" disabled={busy} aria-label="关闭设置" onClick={close}>×</button></div>
        <p>本地回放保留时间</p>
        <label className="settings-choice"><input type="checkbox" checked={unlimited} disabled={busy} onChange={event => { setUnlimited(event.target.checked); setPreview(null); }} />不限制天数</label>
        <label className="settings-days">仅保留最近 <input type="number" min="1" max="36500" step="1" value={days} disabled={busy || unlimited}
          aria-describedby="retention-help" onChange={event => { setDays(event.target.value); setPreview(null); }} /> 天</label>
        <p id="retention-help" className="settings-help">按比赛开始时间计算。更早的回放将从本地删除，并停止上传和下载。线上已有记录保留；游戏原始日志不受影响。</p>
        <p className="settings-help">清理包含回放库、待发送记录、过期回放文件和多余上传暂存。用于增量传输的压缩 Git 历史仍会保留。</p>
        {!valid && <p role="alert">请输入 1–36500 的整数。</p>}
        {preview && <p className="settings-preview">{preview.expired_records ? `将清理 ${preview.expired_records} 条本地记录，回放内容约 ${size(preview.estimated_replay_bytes)}。` : '当前没有超期本地回放。'} 保存时也会清理不再需要的上传暂存。</p>}
        {error && <p role="alert">{error}</p>}
        {result && <p role="status">{result}</p>}
        <div className="settings-actions"><button type="button" className="standard-button" disabled={busy} onClick={close}>关闭</button>
          <button type="submit" className="standard-button" disabled={busy || !valid || !preview} aria-busy={busy}>{busy ? '正在保存并释放空间…' : '保存并清理本地'}</button></div>
      </form>
    </dialog>
  </>;
}
