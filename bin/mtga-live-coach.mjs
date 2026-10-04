#!/usr/bin/env node
import { randomInt } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCoachConfig, coachConfigDir, clearSiwcPlanOnlyConfirmation } from '../src/live-coach/config.mjs';
import { BudgetLedger, SiwcAuth, createModelProvider, MiniMaxVoiceProvider, ElevenVoiceProvider } from '../src/live-coach/providers/index.mjs';
import { ReplaySource } from '../src/live-coach/sources.mjs';
import { LiveCoachRuntime } from '../src/live-coach/runtime.mjs';
import { CoachController } from '../src/live-coach/controller.mjs';
import { startReplayServer } from '../src/server.mjs';
import { defaultDataDir } from '../src/history.mjs';
import { CoachSetup } from '../src/live-coach/setup.mjs';
import { evaluateModelCases } from '../src/live-coach/evaluation.mjs';

const run = promisify(execFile);
const defaultRepo = fileURLToPath(new URL('../../../', import.meta.url));
const seed = '32cdbcfa-61f6-4a18-a0a1-afad6dab3062';
const help = `Usage: mtga-gpt-replay live-coach [serve | status | login | voices | voice-compare | models | evaluate] --enable
  --repo-dir PATH     Local coach source at a locked ref; manual replay sync uses the saved PRIVATE repository
  --config-dir PATH   Separate private grant/tokens/voice configuration
  --match ID          Initial replay match; history retains the whole local corpus
  --mode replay      Default; live requires a separate saved controllable-practice grant
  --log PATH         Live read-only official log (not used by default)
  --model-provider NAME  siwc | deepseek; explicit selection, no fallback
  --model ID          Must exist in the selected account catalog
  --provider NAME    voices: minimax | eleven (no automatic provider fallback)
  --script PATH      voice-compare: JSON array of 12 {id,text,emotion} scripts
  evaluate            Same 8 sanitized real windows; 5 model requests, no TTS
  --output PATH      Private test records/audio directory (default: config-dir/runtime)
  --offline          No model/TTS generation; setup catalog queries require a click
  --no-open          Do not open browser
  --port N           Loopback Viewer port (default: random)
The feature is OFF without --enable or MTGA_LIVE_COACH=1. Toolbar replay sync is manual and reuses the canonical pipeline.
No microphone, game modification or automatic input.`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    enable: { type: 'boolean' }, help: { type: 'boolean' }, 'repo-dir': { type: 'string' }, 'config-dir': { type: 'string' },
    match: { type: 'string' }, mode: { type: 'string' }, log: { type: 'string' }, provider: { type: 'string' }, 'model-provider': { type: 'string' }, model: { type: 'string' },
    script: { type: 'string' }, output: { type: 'string' }, offline: { type: 'boolean' }, 'no-open': { type: 'boolean' }, port: { type: 'string' }
  } });
  if (values.help) { console.log(help); return; }
  if (!values.enable && process.env.MTGA_LIVE_COACH !== '1') throw new Error('Live Coach 功能开关关闭。使用 --enable 单独启用；旧回放功能保持原行为。');
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve','status','login','voices','voice-compare','models','evaluate'].includes(command)) throw new Error(help);
  const configDir = resolve(values['config-dir'] ?? coachConfigDir()), config = await readCoachConfig(configDir, { provider: values['model-provider'], model: values.model });
  const budget = new BudgetLedger({ filePath: join(configDir, 'usage.json'), grant: config.grant });
  const auth = new SiwcAuth({ configDir, grant: config.grant });
  const model = createModelProvider(config, { auth, budget });
  const mini = config.minimaxKey ? new MiniMaxVoiceProvider({ apiKey: config.minimaxKey, budget, region: config.minimaxRegion }) : null;
  const eleven = config.elevenKey ? new ElevenVoiceProvider({ apiKey: config.elevenKey, budget }) : null;
  if (command === 'status') {
    console.log(JSON.stringify({ feature: 'explicitly_enabled', mode: 'replay', auth: await auth.summary(),
      model_provider: config.modelProvider, selected_model: config.modelId, model_usage: config.modelProvider === 'deepseek' ? model.budget.summary() : null,
      plan_only_confirmed: config.siwcPlanOnlyConfirmed, minimax: { account_configured: Boolean(mini), voice_id: config.minimaxVoiceId },
      eleven: { account_configured: Boolean(eleven), voice_id: config.elevenVoiceId }, usage: budget.summary() }, null, 2)); return;
  }
  if (values.offline && ['login','voices','voice-compare','models','evaluate'].includes(command)) throw new Error('该命令需要已授权真实云接口；--offline 不会伪造验收结果。');
  if (command === 'models') { console.log(JSON.stringify({ provider: config.modelProvider, selected_model: config.modelId, available_models: await model.availableModels(), inference_verified: false }, null, 2)); return; }
  if (command === 'login') {
    if (config.modelProvider !== 'siwc') throw new Error('SIWC 登录仅适用于明确选择的 SIWC 路径。');
    // Credits preference is account/app specific. A new login invalidates any earlier assurance.
    clearSiwcPlanOnlyConfirmation(configDir);
    const authorization = await auth.startAuthorization({ timeoutMs: 600000 });
    console.log(`官方 SIWC 登录已启动：${authorization.url}`);
    if (!values['no-open']) await run('/usr/bin/open', [authorization.url]);
    const abort = () => authorization.cancel(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { await authorization.completion; const models = await model.availableModels({});
      console.log(JSON.stringify({ auth: await auth.summary(), available_models: models, selected_model: config.modelId, inference_verified: false }, null, 2)); }
    finally { authorization.cancel(); process.off('SIGINT', abort); process.off('SIGTERM', abort); }
    return;
  }
  if (command === 'voices') {
    const provider = values.provider === 'eleven' ? eleven : values.provider === 'minimax' ? mini : null;
    if (!provider) throw new Error('指定供应商账户缺失。配置 MINIMAX_API_KEY 或 ELEVENLABS_API_KEY；不会换收费后端。');
    console.log(JSON.stringify(await provider.availableVoices({}), null, 2)); return;
  }
  const repoDir = resolve(values['repo-dir'] ?? defaultRepo), output = resolve(values.output ?? join(configDir, 'runtime'));
  if (command === 'voice-compare') {
    if (!mini || !eleven || !config.minimaxVoiceId || !config.elevenVoiceId) throw new Error('两家真实语音账户或经目录确认的中文现成音色缺失，试听阻塞。');
    if (!values.script) throw new Error('仓库缺原始试听 CSV。提供 --script 的 12 条相同 JSON 脚本；不拿文案冒充样音。');
    const scripts = JSON.parse(await readFile(resolve(values.script), 'utf8'));
    if (!Array.isArray(scripts) || scripts.length !== 12 || scripts.some(row=>typeof row.text!=='string'||row.text.length>300)) throw new Error('试听需要 12 条短文本脚本。');
    await mkdir(output,{recursive:true,mode:0o700});
    const voiceRows = [{provider:mini,name:'minimax',voiceId:config.minimaxVoiceId},{provider:eleven,name:'eleven',voiceId:config.elevenVoiceId}];
    const records=[];
    // Randomize vendor order independently for each script; filenames do not reveal vendor.
    for (const [index,row] of scripts.entries()) for (const [slot,provider] of (randomInt(2) ? [...voiceRows].reverse() : voiceRows).entries()) {
      const chunks=[];for await(const bytes of provider.provider.synthesize(row.text,{voiceId:provider.voiceId,emotion:row.emotion,intensity:0.3}))chunks.push(bytes);
      const filename=`sample-${String(index*2+slot+1).padStart(2,'0')}.mp3`;const audio=Buffer.concat(chunks);
      if(!audio.length)throw new Error('供应商未返回真实音频。');await writeFile(join(output,filename),audio,{mode:0o600});
      records.push({file:filename,script_id:row.id,provider:provider.name,bytes:audio.length});
    }
    await writeFile(join(output,'reveal.json'),JSON.stringify({records,usage:budget.summary(),listening_verified:false},null,2)+'\n',{mode:0o600});
    console.log(`24 条真实样音已保存：${output}；真人盲听尚待执行。`);return;
  }
  if (command === 'evaluate') {
    const report = await evaluateModelCases(model, { evidenceMode: 'real_service' });
    await mkdir(output, { recursive: true, mode: 0o700 });
    const filename = `${config.modelProvider}-${config.modelId}-evaluation.json`;
    await writeFile(join(output, filename), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ tested_windows: report.results.length, model_requests: report.model_requests, model_usage: report.model_usage, strategy_independently_adjudicated: false }, null, 2)); return;
  }
  if (!['replay','live'].includes(values.mode??'replay')) throw new Error('mode must be replay or explicitly authorized live practice.');
  let tacticalModel = null, modelStatus = 'offline: cloud generation disabled';
  if (!values.offline) {
    try {
      const catalog = await model.availableModels();
      if (!catalog.some(row => row.slug === config.modelId)) throw new Error('所选型号不在实际账户目录；模型通道暂停，未切换其他型号。');
      if (config.modelProvider === 'siwc' && !config.siwcPlanOnlyConfirmed) throw new Error('尚未确认此 SIWC app 的 credits fallback 已关闭；模型通道暂停。');
      if (config.modelProvider === 'deepseek' && !model.canInfer()) throw new Error('DeepSeek 付费推理尚未单独授权。');
      tacticalModel = model; modelStatus = `${config.modelProvider} / ${config.modelId} / verified account catalog`;
    } catch (error) { modelStatus = error.message; console.error(`战术模型阻塞：${modelStatus}`); }
  }
  const controller = new CoachController({ voice: values.offline ? null : mini, model: tacticalModel, modelStatus,
    ledger: budget, voiceId: config.minimaxVoiceId });
  const source = await ReplaySource.open({ repoDir, matchId: values.match ?? seed });
  // Lookup only resolves observed Arena IDs; unknown/new cards remain rule-missing.
  const names = new Map(source.cards.map(card => [Number(card.arena_id), card.name]));
  const runtime = new LiveCoachRuntime({ repoDir, controller, sourceMode: values.mode??'replay', logPath:values.log,
    livePractice:config.livePractice, names, rules: source.cards });
  runtime.setup = await new CoachSetup({ directory: configDir, auth, model, budget, controller, offline: Boolean(values.offline), modelFactory: latest => createModelProvider(latest, { auth, budget }), modelSelection: { provider: values['model-provider'], model: values.model } }).initialize();
  runtime.sources.set(source.summary.match_id, Promise.resolve(source));
  // UI receives the immutable recorded replay; only its currently selected LiveState enters inference.
  const replayProvider = await runtime.replayProvider();
  // Reuse the existing public card cache; replay reads still use the same verified source as the coach.
  // Restore the explicitly requested toolbar action using the existing canonical
  // replay sync. Coaching stays pinned to its separate immutable source.
  const server=await startReplayServer({port:Number(values.port??0),dataDir:defaultDataDir(),writeInfo:false,liveCoach:runtime,replayProvider,
    enableReplaySync:true});
  console.log(`Live Coach 回放：${server.url}?match=${source.summary.match_id}\n语音：${values.offline?'离线验证，真实语音未测':mini&&config.minimaxVoiceId?'MiniMax已配置，首次实际调用仍需核验':'真实语音账户/音色缺失'}\n计划额度与费用：${JSON.stringify(budget.summary())}`);
  if(!values['no-open'])await run('/usr/bin/open',[`${server.url}?match=${source.summary.match_id}`]);
  let closing=false;const close=async()=>{if(closing)return;closing=true;await server.close();process.exit(0);};
  process.once('SIGINT',close);process.once('SIGTERM',close);
  return {server,runtime};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(`mtga-live-coach: ${error.message}`);process.exitCode=1;});
