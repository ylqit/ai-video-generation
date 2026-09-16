import { prepareShot } from '../shared/directing.js';
import { sampleShot } from '../shared/spatial.js';
import type { EpisodePlan } from '../shared/contracts.js';

// Standalone review artifact. Geometry is taken from shot states, never project names.
export function previsualizationHtml(plan: EpisodePlan) {
  const samples = plan.shots.map((shot) => {
    const spec = prepareShot(shot);
    return Array.from({ length: spec.frames }, (_, frame) =>
      sampleShot(spec, frame)
        .instances.map((i: any) => i.pose)
        .filter(Boolean),
    );
  });
  const serialized = JSON.stringify({ ...plan, samples }).replaceAll('<', '\\u003c');
  const title = plan.title.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 分镜预演</title>
<style>body{margin:24px;background:#122029;color:#e7eeee;font:17px/1.7 system-ui}main{max-width:1000px;margin:auto}button,select{padding:10px}svg{width:100%;background:#24363e}input[type=range]{width:100%}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.note{color:#eccb92}</style>
<main><h1>${title}</h1><p class="note">分镜与二维状态示意；没有配置状态的镜头保持空白，不推测空间。三维机位和构图参考请在创作台的导演设计中打开。</p><button id="play">播放</button><select id="shots"></select><span id="time"></span><input id="seek" type="range" min="0" step="1"><div class="grid"><svg viewBox="0 0 500 500" id="map"></svg><article><h2 id="name"></h2><p id="description"></p><p id="camera"></p><p id="sound"></p></article></div></main>
<script>const plan=${serialized};let frame=0,playing=false,last=0;const starts=[];let total=0;for(const s of plan.shots){starts.push(total);total+=Math.round(s.duration*24)}const get=id=>document.getElementById(id);get('seek').max=Math.max(0,total-1);for(const s of plan.shots){const o=document.createElement('option');o.textContent=s.id+' '+s.description;o.value=s.id;get('shots').append(o)}function text(id,value){get(id).textContent=value||''}function draw(){if(!plan.shots.length)return;let n=starts.findIndex((f,i)=>frame>=f&&(i===starts.length-1||frame<starts[i+1]));const s=plan.shots[Math.max(0,n)];text('time',' '+(frame/24).toFixed(3)+' / '+(total/24).toFixed(3)+' 秒');get('seek').value=frame;get('shots').value=s.id;text('name',s.id+' · '+s.scene);text('description',s.description);text('camera',s.directing?.camera?.description||s.state?.cameraIntent||s.production?.camera);text('sound',s.directing?.sound?.environment||s.production?.sound);get('map').replaceChildren();for(const p of plan.samples[n]?.[frame-starts[n]]||[]){const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',p.position.x*500);c.setAttribute('cy',p.position.y*500);c.setAttribute('r',10);c.setAttribute('fill','#e4bc76');get('map').append(c);const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',p.position.x*500+14);label.setAttribute('y',p.position.y*500);label.setAttribute('fill','white');label.textContent=p.instanceId;get('map').append(label)}}get('play').onclick=()=>{playing=!playing;text('play',playing?'暂停':'播放')};get('seek').oninput=e=>{frame=+e.target.value;draw()};get('shots').onchange=e=>{frame=starts[plan.shots.findIndex(s=>s.id===e.target.value)];draw()};function tick(now){if(playing&&now-last>=1000/24){frame=(frame+1)%Math.max(1,total);draw();last=now}if(!playing)last=now;requestAnimationFrame(tick)}draw();requestAnimationFrame(tick);</script></html>`;
}
