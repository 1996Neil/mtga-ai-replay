import { useEffect, useId, useRef, useState } from 'react';
import { coachModelUpdate, coachSetupUpdate, readCoachSetup, readCoachVoices, refreshCoachModels, saveCoachSetup } from '../lib/coachSetup';
import type { CoachSetup, ModelProvider, MinimaxRegion, StockVoice, VoiceProvider } from '../lib/coachSetup';

export function LiveCoachSetup({ onBeforeSave, onSavingChange }: { onBeforeSave: () => Promise<void>; onSavingChange: (saving: boolean) => void }) {
  const id = useId(), active = useRef(true), inFlight = useRef(true), request = useRef<AbortController | null>(null);
  const [setup, setSetup] = useState<CoachSetup | null>(null), [busy, setBusy] = useState('load');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [minimaxKey, setMinimaxKey] = useState(''), [elevenKey, setElevenKey] = useState('');
  const [minimaxVoiceId, setMinimaxVoiceId] = useState(''), [elevenVoiceId, setElevenVoiceId] = useState('');
  const [modelProvider, setModelProvider] = useState<ModelProvider>('siwc'), [modelId, setModelId] = useState('');
  const [minimaxRegion, setMinimaxRegion] = useState<MinimaxRegion>('global');
  const applySetup = (next: CoachSetup, updateSelection = false) => {
    setSetup(next);
    if (updateSelection) { setModelProvider(next.auth.provider); setModelId(next.auth.selectedModel || ''); setMinimaxVoiceId(next.voice.minimax.voiceId || ''); setElevenVoiceId(next.voice.eleven.voiceId || ''); setMinimaxRegion(next.voice.minimax.region || 'global'); }
  };
  useEffect(() => {
    active.current = true;
    const controller = new AbortController(); request.current = controller;
    const current = () => active.current && request.current === controller && !controller.signal.aborted;
    void readCoachSetup(controller.signal).then(next => { if (current()) applySetup(next, true); })
      .catch(() => { if (current()) setError('无法读取设置，请确认本机教练服务正在运行。'); })
      .finally(() => { if (current()) { inFlight.current = false; setBusy(''); } });
    return () => { active.current = false; request.current?.abort(); onSavingChange(false); };
  }, []);
  const run = async (action: string, operation: (signal: AbortSignal) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController(); request.current = controller;
    setBusy(action); setError(''); setMessage('');
    try { await operation(controller.signal); }
    catch (failure) { if (active.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '设置请求未完成。'); }
    finally { inFlight.current = false; if (active.current) setBusy(''); }
  };
  const save = () => { void run('save', async signal => {
    const update = { ...coachSetupUpdate({ minimaxKey, elevenKey, minimaxVoiceId, elevenVoiceId, minimaxRegion }, setup?.voice),
      ...(setup ? coachModelUpdate(modelProvider, modelId, setup.auth) : {}) };
    if (!Object.keys(update).length) { setMessage('尚无配置变化；已存配置保留。'); return; }
    onSavingChange(true);
    try {
      await onBeforeSave();
      if (signal.aborted) return;
      const next = await saveCoachSetup(update, signal);
      if (!active.current) return;
      applySetup(next, true); setMinimaxKey(''); setElevenKey('');
      setMessage('已保存到本机，密钥输入已清空。当前教练已静音，需手动恢复声音。');
    } finally { if (active.current) onSavingChange(false); }
  }); };
  const refreshModels = () => { void run('models', async signal => {
    const next = await refreshCoachModels(signal);
    if (active.current) { applySetup(next, true); setMessage('已刷新所选供应商的实际账户模型目录。'); }
  }); };
  const refreshVoices = (provider: VoiceProvider) => { void run(provider, async signal => {
    const voices = await readCoachVoices(provider, signal);
    if (!active.current) return;
    setSetup(old => old && ({ ...old, voice: { ...old.voice, [provider]: { ...old.voice[provider], voices } } }));
    setMessage(voices.length ? `已读取 ${provider === 'minimax' ? 'MiniMax' : 'ElevenLabs'} 的 ${voices.length} 个内置音色。` : '当前服务没有返回可用的内置音色。');
  }); };
  const providerFields = (provider: VoiceProvider, name: string, key: string, setKey: (value: string) => void,
    voiceId: string, setVoiceId: (value: string) => void) => {
    const saved = setup?.voice[provider], voices: StockVoice[] = saved?.voices || [];
    return <fieldset className="coach-voice-provider" disabled={!!busy || !setup}>
      <legend>{name} <span>{saved?.keyConfigured ? (saved.keySource === 'environment' ? '环境密钥已配置' : '本机密钥已配置') : '密钥未配置'}</span></legend>
      {provider === 'minimax' && <>
        <label htmlFor={`${id}-minimax-region`}>服务区域 <small>{saved?.regionSource === 'environment' ? '由启动环境提供' : '本机设置'}</small></label>
        <select id={`${id}-minimax-region`} value={minimaxRegion} onChange={event => setMinimaxRegion(event.target.value as MinimaxRegion)} disabled={saved?.regionSource === 'environment'}>
          <option value="china">中国大陆</option><option value="global">国际</option>
        </select>
        <small>{saved?.regionSource === 'environment' ? '区域由启动环境提供，需修改环境后重启；本机设置不能覆盖。' : '密钥须与所选区域一致；更改区域后请先保存，再读取目录。'}</small>
      </>}
      <label htmlFor={`${id}-${provider}-key`}>API Key <small>{saved?.keySource === 'environment' ? '由启动环境提供' : '留空保留已存密钥'}</small></label>
      <input id={`${id}-${provider}-key`} type="password" value={key} onChange={event => setKey(event.target.value)}
        autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2048}
        disabled={saved?.keySource === 'environment'} aria-describedby={`${id}-privacy`}
        placeholder={saved?.keySource === 'environment' ? '由启动环境提供' : saved?.keyConfigured ? '输入新密钥以替换' : '输入该服务的 API Key'} />
      {saved?.keySource === 'environment' && <small>密钥由启动环境提供，需修改环境后重启；本机设置不能覆盖。</small>}
      <label htmlFor={`${id}-${provider}-voice`}>内置音色 <small>{saved?.voiceSource === 'environment' ? '由启动环境提供' : '本机设置'}</small></label>
      <select id={`${id}-${provider}-voice`} value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={saved?.voiceSource === 'environment'}>
        <option value="">选择音色</option>
        {voiceId && !voices.some(voice => voice.id === voiceId) && <option value={voiceId}>当前音色 · {voiceId}</option>}
        {voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}{voice.language ? ` · ${voice.language}` : ''}{voice.gender ? ` · ${voice.gender}` : ''}</option>)}
      </select>
      {saved?.voiceSource === 'environment' && <small>音色由启动环境提供，需修改环境后重启；本机设置不能覆盖。</small>}
      <button type="button" onClick={() => refreshVoices(provider)} disabled={!saved?.keyConfigured || (provider === 'minimax' && minimaxRegion !== saved.region)} aria-busy={busy === provider}>
        {busy === provider ? '正在读取…' : '读取音色目录'}</button>
      <small>新密钥请先保存，再读取目录。当前音色：{saved?.voiceId || '未选择'}</small>
    </fieldset>;
  };
  return <div className="live-coach-setup" aria-busy={!!busy}>
    <p id={`${id}-privacy`} className="coach-setup-note">密钥只保存到本机，不回显已有密钥；此功能不使用麦克风。读取目录只请求服务元数据。</p>
    {busy === 'load' && <p role="status">正在读取本机设置…</p>}
    {setup && <div className="coach-connection-status">
      <div><strong>连接状态</strong><button type="button" onClick={refreshModels} disabled={!!busy || modelProvider !== setup.auth.provider} aria-busy={busy === 'models'}>{busy === 'models' ? '正在检查…' : '读取模型账户目录'}</button></div>
      <p>{setup.auth.provider === 'siwc' ? `教练 ChatGPT 登录（SIWC）：${setup.auth.signedIn ? '已登录' : '未登录'}` : 'DeepSeek：独立付费 API，需单独授权'} · {setup.auth.selectedModel || '尚未选择型号'}：{setup.auth.modelAvailable ? '当前目录可用' : '当前目录未验证'}</p>
      {setup.offline && <p className="coach-setup-notice">离线演示：保存配置后需以语音模式启动，当前不会合成语音。</p>}
      {setup.auth.blockedReason && <p>{setup.auth.blockedReason}</p>}
      <details><summary>当前可用模型 · {setup.auth.availableModels.length}</summary>
        {setup.auth.availableModels.length ? <ul>{setup.auth.availableModels.map(model => <li key={model.slug}>{model.display_name} <code>{model.slug}</code></li>)}</ul> : <p>尚未读取到可用模型。请检查教练的 ChatGPT 登录，再刷新目录。</p>}
      </details>
    </div>}
    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <fieldset disabled={!!busy || !setup || setup.auth.selectionSource !== 'local'}>
        <legend>模型连接</legend>
        <label htmlFor={`${id}-model-provider`}>供应商</label>
        <select id={`${id}-model-provider`} value={modelProvider} onChange={event => { setModelProvider(event.target.value as ModelProvider); setModelId(''); }}>
          <option value="siwc">ChatGPT / SIWC 计划额度</option><option value="deepseek">DeepSeek / 单独付费授权</option>
        </select>
        <label htmlFor={`${id}-model-id`}>账户实际型号</label>
        <select id={`${id}-model-id`} value={modelId} onChange={event => setModelId(event.target.value)} disabled={modelProvider !== setup?.auth.provider}>
          <option value="">选择型号</option>
          {modelId && !setup?.auth.availableModels.some(row => row.slug === modelId) && <option value={modelId}>未验证 · {modelId}</option>}
          {modelProvider === setup?.auth.provider && setup.auth.availableModels.map(row => <option key={row.slug} value={row.slug}>{row.display_name} · {row.slug}</option>)}
        </select>
        {setup && setup.auth.selectionSource !== 'local' && <small>型号由启动环境或参数提供，需修改启动配置并重启。</small>}
        <small>切换供应商请先保存，再读取实际目录。保存只更改本机选择并静音，不授予付费预算，也不发起推理。DeepSeek 凭据与预算须另行批准配置。</small>
      </fieldset>
      <div className="coach-voice-grid">
        {providerFields('minimax', 'MiniMax', minimaxKey, setMinimaxKey, minimaxVoiceId, setMinimaxVoiceId)}
        {providerFields('eleven', 'ElevenLabs', elevenKey, setElevenKey, elevenVoiceId, setElevenVoiceId)}
      </div>
      <div className="coach-setup-actions"><button type="submit" disabled={!!busy || !setup} aria-busy={busy === 'save'}>{busy === 'save' ? '正在保存…' : '保存本机配置'}</button><small>保存会取消当前生成并静音。</small></div>
    </form>
    {error && <p role="alert" className="coach-setup-error">{error} {!setup && <button type="button" disabled={!!busy} onClick={() => { void run('load', async signal => { const next = await readCoachSetup(signal); if (active.current) applySetup(next, true); }); }}>重新读取</button>}</p>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </div>;
}
