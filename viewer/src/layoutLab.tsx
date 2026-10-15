import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GameBoard} from './components/GameBoard';
import {layoutFixture} from './lib/layoutFixtures';
import './index.css';
import './board.css';
import './p2-preview.css';
function Lab(){
 const [count,setCount]=useState(7),[scenario,setScenario]=useState('many'),[before,setBefore]=useState(false),[side,setSide]=useState(false);
 const {match,step}=layoutFixture(count,scenario);
 return <div className="app-shell"><header style={{display:'flex',gap:12,padding:8,flexWrap:'wrap',flexShrink:0}}>
 <strong>P1 模拟测试 · 非真实比赛</strong>
 <label>手牌数 <select aria-label="模拟手牌数" value={count} onChange={e=>setCount(Number(e.target.value))}>{[0,1,3,7,12,16].map(n=><option key={n}>{n}</option>)}</select></label>
 <label>场景 <select aria-label="模拟战斗场景" value={scenario} onChange={e=>setScenario(e.target.value)}>{[['permanents','生物／神器／结界／鹏洛客／传纪分区'],['idle','无战斗'],['single','单攻击者'],['many','多对多阻挡'],['planeswalker','鹏洛客目标'],['stack','单项堆叠'],['stack-multi','三项堆叠'],['stack-many','十二项堆叠'],['hidden','未知手牌'],['second-seat','第二席／语义目标边界']].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>
 <button onClick={()=>setCount(n=>n+1)}>抽一张</button><button disabled={!count} onClick={()=>setCount(n=>n-1)}>减少一张手牌</button>
 <label><input aria-label="模拟动作前" type="checkbox" checked={before} onChange={e=>setBefore(e.target.checked)}/>动作前</label>
 <label><input aria-label="模拟侧栏" type="checkbox" checked={side} onChange={e=>setSide(e.target.checked)}/>侧栏</label>
 </header><div className="app-workspace"><GameBoard step={step} match={match} viewBefore={before} analysis={side}/>{side&&<aside style={{width:300,flexShrink:0,padding:12}}>模拟分析侧栏 · 300px</aside>}</div></div>;
}
createRoot(document.getElementById('root')!).render(<Lab/>);
