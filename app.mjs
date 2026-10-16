import { GameWorld, LEVELS } from './physics.mjs';
import { loadRabbitAssets, drawBunny, drawTinyBunny } from './bunny-models.mjs';
import { getRabbitShape } from './rabbit-shapes.mjs';

const $ = id => document.getElementById(id);
const NAMES = LEVELS.map(level => level.name);
const LAST_LEVEL = LEVELS.length - 1;
const KEY = 'bunny-garden-v1';
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let saved;
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { saved = null; }
let best = Number.isInteger(saved?.best) && saved.best >= 0 && saved.best <= 1e9 ? saved.best : 0;
let unlocked = Number.isInteger(saved?.unlocked) && saved.unlocked >= 0 && saved.unlocked < LEVELS.length ? saved.unlocked : 0;
let sound = saved?.sound === true;
let started = false, paused = false, pointerId = null, audioContext;
let width = 360, height = 530, lastFrame = 0, lastSave = 0, toastTimer;
let dialogWasPaused = false, lastFocus, lastScore = -1, lastNext = -1;
let newRecord = false, effects = [], pops = [];
const mergePulses = new Map();
const SPRITE_RADIUS = 100;
const spriteHalfSize = Math.ceil(SPRITE_RADIUS * Math.max(...LEVELS.reduce((values, _, level) => {
  const bounds = getRabbitShape(level).bounds;
  return values.concat([Math.abs(bounds.minX), Math.abs(bounds.minY), Math.abs(bounds.maxX), Math.abs(bounds.maxY)]);
}, [])) + 4);
const spriteExtent = spriteHalfSize / SPRITE_RADIUS;
const sprites = LEVELS.map((_, level) => {
  const image = document.createElement('canvas');
  image.width = image.height = spriteHalfSize * 2;
  drawBunny(image.getContext('2d'), spriteHalfSize, spriteHalfSize, SPRITE_RADIUS, level);
  return image;
});
const world = new GameWorld({ onMerge: merged, onGameOver: gameOver, onWin: () => {
  toast(`${NAMES[LAST_LEVEL]}来啦！继续合成还有惊喜 ♡`, 3500);
  celebrate(180, height / 2, LAST_LEVEL, 28);
} });

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({best, unlocked, sound, game: started ? world.snapshot() : null})); }
  catch { /* The game remains playable when browser storage is unavailable. */ }
}
function setPause(value) {
  paused = value;
  world.paused = !started || value || $('game-dialog').open || document.hidden;
  $('pause-overlay').hidden = !value || !started || world.phase === 'over';
  $('pause-button').querySelector('span').textContent = value ? '继续' : '暂停';
  $('pause-button').setAttribute('aria-label', value ? '继续游戏' : '暂停游戏');
  pointerId = null;
}
function start() {
  started = true;
  $('welcome').hidden = true;
  $('pause-button').disabled = false;
  setPause(false);
  unlock(world.currentLevel);
  updateStats();
  canvas.focus({preventScroll:true});
  save();
}
function freshGame() {
  dialogWasPaused = false;
  closeDialog();
  world.reset(); effects = []; pops = []; newRecord = false;
  mergePulses.clear();
  lastScore = lastNext = -1;
  start();
}
function updateStats() {
  if (world.score !== lastScore) {
    $('score').textContent = world.score;
    if (world.score > best) { best = world.score; newRecord = true; }
    $('best').textContent = best;
    lastScore = world.score;
  }
  if (world.nextLevel !== lastNext) {
    drawTinyBunny($('next-canvas'), world.nextLevel);
    $('next-canvas').setAttribute('aria-label', '下一只：' + NAMES[world.nextLevel]);
    lastNext = world.nextLevel;
  }
  const danger = world.dangerProgress > 0;
  $('field-status').textContent = danger ? '快满啦，找一样的兔兔合成！' : world.phase === 'over' ? '兔兔们已经挤满啦' : '今天也要软乎乎';
}
function unlock(level) {
  if (level <= unlocked) return false;
  unlocked = level;
  updateCollection();
  return true;
}
function updateCollection() {
  $('collection-count').textContent = `${unlocked + 1}/${LEVELS.length}`;
  $('evolution-strip').textContent = '';
  Array.from({length: 6}, (_, index) => Math.round(index * LAST_LEVEL / 5)).forEach((level, index) => {
    if (index) {
      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden','true');
      $('evolution-strip').append(arrow);
    }
    const icon = document.createElement('canvas');
    icon.width = icon.height = 80;
    icon.className = level > unlocked ? 'undiscovered' : '';
    icon.setAttribute('aria-label', NAMES[level] + (level > unlocked ? '，待发现' : '，已发现'));
    drawTinyBunny(icon, level);
    $('evolution-strip').append(icon);
  });
}
function toast(message, duration = 2200) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').classList.add('visible');
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), duration);
}
function activateAudio() {
  if (!sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch { sound = false; updateSound(); }
}
function tone(frequency, duration = .1, delay = 0, volume = .04) {
  if (!sound || !audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  const time = audioContext.currentTime + delay;
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency,time);
  gain.gain.setValueAtTime(0,time); gain.gain.linearRampToValueAtTime(volume,time+.012);
  gain.gain.exponentialRampToValueAtTime(.001,time+duration);
  oscillator.connect(gain); gain.connect(audioContext.destination);
  oscillator.start(time); oscillator.stop(time+duration+.02);
}
function updateSound() {
  $('sound-button').classList.toggle('sound-enabled',sound);
  $('sound-button').setAttribute('aria-pressed',String(sound));
  $('sound-button').setAttribute('aria-label',sound ? '关闭音效' : '开启音效');
}
function celebrate(x,y,level,count=12) {
  if (reducedMotion) return;
  const colors = ['#e8a1b4','#ecc879','#a8c8a2','#b9a5d2','#efb999'];
  for(let i=0;i<count;i++) {
    const angle = Math.random() * Math.PI * 2, speed = 40 + Math.random()*100;
    effects.push({x,y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed-30,life: .65 + Math.random()*.35,age:0,color:colors[i%5],size:2+Math.random()*3});
  }
  pops.push({x,y,level,age:0});
}
function merged(event) {
  celebrate(event.x,event.y,event.level);
  if (!reducedMotion && event.bodyId !== undefined) mergePulses.set(event.bodyId, 0);
  updateStats();
  const isNew = unlock(event.level);
  $('game-announcement').textContent = `合成${NAMES[event.level]}，获得${event.points}分。当前${world.score}分。`;
  if (isNew) toast(`新朋友：${NAMES[event.level]} ♡`);
  if(event.final) toast(`${NAMES[LAST_LEVEL]}团圆！奖励 ${event.points} 分 ♡`);
  tone(520 + event.level * 55,.13); tone(780 + event.level*60,.18,.075,.025);
  save();
}
function gameOver() {
  updateStats(); save();
  pointerId = null;
  openDialog(`<canvas id="result-art" class="result-art" width="240" height="240" aria-hidden="true"></canvas><h2 id="dialog-title">兔兔们挤满啦</h2><p class="dialog-copy">每一次贴贴，都是一点点进步。</p><div class="result-score"><small>本局得分</small>${world.score}</div>${newRecord ? '<div class="record">✦ 新纪录！你的兔兔超争气</div>' : `<p class="dialog-copy">最高纪录 ${best}</p>`}<button id="again-button" class="primary-button">再来一局</button>`);
  drawTinyBunny($('result-art'),Math.max(1,Math.min(unlocked,LAST_LEVEL)));
  $('again-button').onclick = freshGame;
  tone(440,.16); tone(330,.22,.18);
}
function openDialog(html) {
  if ($('game-dialog').open) return;
  lastFocus = document.activeElement;
  dialogWasPaused = paused;
  pointerId = null; world.paused = true;
  $('dialog-content').innerHTML = html;
  const dialog = $('game-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else {
    dialog.setAttribute('open', ''); dialog.open = true;
    dialog.classList.add('dialog-fallback'); document.body.classList.add('dialog-visible');
    $('close-dialog').focus();
  }
}
function closeDialog() {
  const dialog = $('game-dialog');
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else {
    dialog.removeAttribute('open'); dialog.open = false;
    document.body.classList.remove('dialog-visible');
    resumeAfterDialog();
  }
}
function resumeAfterDialog() {
  setPause(dialogWasPaused);
  if (lastFocus?.isConnected) lastFocus.focus({preventScroll:true});
}
$('game-dialog').addEventListener('close', resumeAfterDialog);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('game-dialog').classList.contains('dialog-fallback')) closeDialog();
});
$('close-dialog').onclick = closeDialog;
$('game-dialog').addEventListener('click',event => {
  if (event.target === $('game-dialog')) {
    const rect = $('game-dialog').getBoundingClientRect();
    if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  }
});
$('start-button').onclick = () => { activateAudio(); start(); };
$('sound-button').onclick = () => { sound = !sound; updateSound(); activateAudio(); if(sound) tone(680,.13); save(); };
$('pause-button').onclick = () => { if(started && world.phase === 'playing') setPause(!paused); };
$('resume-button').onclick = () => { activateAudio(); setPause(false); canvas.focus({preventScroll:true}); };
$('help-button').onclick = () => {
  openDialog(`<h2 id="dialog-title">一起养大兔兔</h2><p class="dialog-copy">不用着急，让小可爱慢慢团圆。</p><ol class="rules"><li><b>1</b><span>在花园里<bdi>拖动手指</bdi>瞄准，<bdi>松手</bdi>让兔兔落下。轻点也可以投放。</span></li><li><b>2</b><span>两只一样的兔兔碰到一起，就会合成下一只更大的兔兔。</span></li><li><b>3</b><span>兔兔堆过虚线一小会儿，花园就满了。两只${NAMES[LAST_LEVEL]}相碰会消除，送你额外分数。</span></li></ol><p class="dialog-copy">电脑：← → 瞄准，空格投放。<br>手机：浏览器菜单可“添加到主屏幕”。<br>进度和最高分保存在当前浏览器里。</p><button id="help-done" class="primary-button">知道啦，去贴贴</button>`);
  $('help-done').onclick = closeDialog;
};
$('collection-button').onclick = () => {
  openDialog(`<h2 id="dialog-title">兔兔成长图鉴</h2><p class="dialog-copy">两只一样的，合成下一只。<br>已经遇见 ${unlocked+1} / ${LEVELS.length} 位小可爱</p><div id="collection-grid" class="collection-grid"></div>`);
  NAMES.forEach((name,level) => {
    const item = document.createElement('div'); item.className='collection-item'+(level > unlocked ? ' locked':'');
    const icon = document.createElement('canvas'); icon.width=icon.height=120; drawTinyBunny(icon,level);
    icon.setAttribute('aria-hidden','true');
    const detail = document.createElement('div');
    detail.innerHTML=`<strong>${name}</strong><small>${level > unlocked ? '等你发现' : '已经遇见 ♡'}</small>`;
    item.append(icon,detail); $('collection-grid').append(item);
  });
};
$('restart-button').onclick = () => {
  if(!started || (!world.bodies.length && !world.score)) { freshGame(); return; }
  openDialog('<h2 id="dialog-title">重新开一局？</h2><p class="dialog-copy">本局进度会清空。<br>最高纪录和发现的兔兔会保留。</p><button id="confirm-restart" class="primary-button">重新开始</button><button id="cancel-restart" class="secondary-button">再陪兔兔玩一会儿</button>');
  $('confirm-restart').onclick=freshGame; $('cancel-restart').onclick=closeDialog;
};
function clampAim(x) {
  const r=LEVELS[world.currentLevel].radius, bounds=getRabbitShape(world.currentLevel).bounds;
  return Math.max(-bounds.minX*r+2,Math.min(width-bounds.maxX*r-2,x));
}
function aim(event) {
  const rect=canvas.getBoundingClientRect();
  world.aimX=clampAim((event.clientX-rect.left)/rect.width*width);
}
function drop() {
  activateAudio();
  if(world.paused || !started) return;
  const body=world.drop();
  if(body) { unlock(body.level); tone(250,.07,0,.025); updateStats(); $('play-hint').querySelector('span').textContent='一样的兔兔碰一碰，就会长大哦'; save(); }
}
canvas.addEventListener('pointerdown',event => {
  if(event.button!==0 || !started || world.paused || world.phase!=='playing') return;
  event.preventDefault(); pointerId=event.pointerId;
  if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(pointerId);
  aim(event); activateAudio();
});
canvas.addEventListener('pointermove',event => { if(event.pointerId===pointerId || (event.pointerType==='mouse' && !world.paused)) aim(event); });
canvas.addEventListener('pointerup',event => {
  if(event.pointerId!==pointerId) return;
  aim(event); pointerId=null;
  if(typeof canvas.hasPointerCapture === 'function' && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  drop();
});
canvas.addEventListener('pointercancel',() => {pointerId=null;});
canvas.addEventListener('lostpointercapture',() => {pointerId=null;});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
if (typeof window.PointerEvent === 'undefined') {
  let touchActive = false, mouseActive = false;
  canvas.addEventListener('touchstart', event => {
    if (!started || world.paused || world.phase !== 'playing') return;
    event.preventDefault(); touchActive = true; aim(event.touches[0]); activateAudio();
  }, {passive:false});
  canvas.addEventListener('touchmove', event => {
    if (!touchActive) return;
    event.preventDefault(); aim(event.touches[0]);
  }, {passive:false});
  canvas.addEventListener('touchend', event => {
    if (!touchActive) return;
    event.preventDefault(); aim(event.changedTouches[0]); touchActive = false; drop();
  }, {passive:false});
  canvas.addEventListener('touchcancel', () => {touchActive = false;});
  canvas.addEventListener('mousedown', event => {
    if (event.button !== 0 || !started || world.paused) return;
    event.preventDefault(); mouseActive = true; aim(event);
  });
  window.addEventListener('mousemove', event => {if (mouseActive) aim(event);});
  window.addEventListener('mouseup', event => {if (mouseActive) {mouseActive = false; aim(event); drop();}});
}
canvas.addEventListener('keydown',event => {
  if(!started || world.paused || world.phase!=='playing')return;
  if(['ArrowLeft','ArrowRight',' '].includes(event.key)) event.preventDefault();
  if(event.key==='ArrowLeft')world.aimX=clampAim(world.aimX-12);
  if(event.key==='ArrowRight')world.aimX=clampAim(world.aimX+12);
  if(event.key===' '&&!event.repeat)drop();
});
document.addEventListener('visibilitychange',() => {
  if(document.hidden){ save(); if(started && world.phase==='playing')setPause(true); audioContext?.suspend().catch(()=>{}); }
  lastFrame=0;
});
window.addEventListener('pagehide',save);

function resize() {
  const rect=canvas.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
  height=360*rect.height/rect.width;
  ctx.setTransform(canvas.width/width,0,0,canvas.height/height,0,0);
  world.resize(width,height-12);
}
if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe($('board'));
else {
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
}
function bunny(x,y,r,level,angle=0,alpha=1) {
  ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.rotate(angle);
  ctx.drawImage(sprites[level],-r*spriteExtent,-r*spriteExtent,r*spriteExtent*2,r*spriteExtent*2);ctx.restore();
}
function flower(x,y,size,color) {
  ctx.save();ctx.translate(x,y);ctx.fillStyle=color;
  for(let j=0;j<5;j++){ctx.rotate(Math.PI*2/5);ctx.beginPath();ctx.ellipse(0,-size*.8,size*.48,size*.72,0,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#e8c381';ctx.beginPath();ctx.arc(0,0,size*.4,0,Math.PI*2);ctx.fill();ctx.restore();
}
function drawBackground() {
  ctx.fillStyle='#fffaf4';ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='#f3eae0';ctx.lineWidth=.65;ctx.beginPath();
  for(let x=16;x<width;x+=24){ctx.moveTo(x,0);ctx.lineTo(x,height);}
  for(let y=12;y<height;y+=24){ctx.moveTo(0,y);ctx.lineTo(width,y);}
  ctx.stroke();
  ctx.fillStyle='#e8eddc';ctx.beginPath();ctx.moveTo(0,height);
  ctx.lineTo(0,height-18);ctx.bezierCurveTo(60,height-37,100,height-2,180,height-19);ctx.bezierCurveTo(260,height-37,300,height-6,360,height-22);ctx.lineTo(360,height);ctx.fill();
  flower(27,height-20,5,'#fffdf5');flower(330,height-18,5,'#efd4dc');flower(300,height-8,3,'#fffdf5');
  ctx.strokeStyle='#b3c6a7';ctx.lineWidth=1.5;
  [50,61,315].forEach(x=>{ctx.beginPath();ctx.moveTo(x,height-6);ctx.quadraticCurveTo(x-2,height-17,x-5,height-15);ctx.moveTo(x,height-6);ctx.quadraticCurveTo(x+1,height-20,x+5,height-19);ctx.stroke();});
  if(!started)return;
  const danger=world.dangerProgress>0;
  ctx.strokeStyle=danger?'#d66c82':'#e6c5c8';ctx.lineWidth=danger?1.7:1;ctx.setLineDash([5,6]);
  ctx.beginPath();ctx.moveTo(12,world.dangerY);ctx.lineTo(width-12,world.dangerY);ctx.stroke();ctx.setLineDash([]);
  ctx.font='9px "Microsoft YaHei",sans-serif';ctx.textAlign='right';ctx.fillStyle=danger?'#c55470':'#c4a5aa';
  ctx.fillText(danger?'花园快满啦！':'别超过这条线哦',width-15,world.dangerY-8);
}
function drawAim() {
  if(!started || world.phase!=='playing' || world.paused)return;
  const r=LEVELS[world.currentLevel].radius;
  const bounds=getRabbitShape(world.currentLevel).bounds;
  const previewY=Math.max(58,10-bounds.minY*r);
  world.aimX=clampAim(world.aimX);
  ctx.strokeStyle='#d9bbc2';ctx.lineWidth=1.1;ctx.setLineDash([2,7]);
  ctx.beginPath();ctx.moveTo(world.aimX,previewY+bounds.maxY*r+4);ctx.lineTo(world.aimX,world.height);ctx.stroke();ctx.setLineDash([]);
  bunny(world.aimX,previewY,r,world.currentLevel,0,world.canDrop?1:.35);
  ctx.fillStyle='#d595a8';ctx.beginPath();ctx.moveTo(world.aimX-3,5);ctx.lineTo(world.aimX+3,5);ctx.lineTo(world.aimX,9);ctx.fill();
}
function render(time) {
  const dt=lastFrame?Math.min((time-lastFrame)/1000,.05):0; lastFrame=time;
  if(started && !world.paused)world.step(dt);
  drawBackground();
  mergePulses.forEach((age, id) => {
    const nextAge = age + (world.paused ? 0 : dt);
    if(nextAge >= .28 || !world.bodies.some(body => body.id === id)) mergePulses.delete(id);
    else mergePulses.set(id, nextAge);
  });
  for(const body of world.bodies) {
    const age = mergePulses.get(body.id);
    const scale = age === undefined ? 1 : 1 + .09 * Math.sin(Math.PI * age / .28);
    bunny(body.x,body.y,body.radius * scale,body.level,body.angle);
  }
  drawAim();
  if(!world.paused){
    effects=effects.filter(p=>p.age<p.life);
    for(const p of effects){p.age+=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=180*dt;ctx.globalAlpha=Math.max(0,1-p.age/p.life);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();}
    ctx.globalAlpha=1;
    pops=pops.filter(p=>p.age<.5);
    for(const p of pops){p.age+=dt;ctx.strokeStyle='#e9a3b5';ctx.lineWidth=2;ctx.globalAlpha=Math.max(0,1-p.age/.5);ctx.beginPath();ctx.arc(p.x,p.y,LEVELS[p.level].radius*(.9+p.age),0,Math.PI*2);ctx.stroke();}
    ctx.globalAlpha=1;
  }
  updateStats();
  if(time-lastSave>3000){ if(started && !world.paused)save(); lastSave=time; }
  requestAnimationFrame(render);
}
function welcomeArt() {
  const art=$('welcome-art'), c=art.getContext('2d');c.clearRect(0,0,520,320);
  c.fillStyle='#f4e5e4';c.beginPath();c.ellipse(260,281,185,16,0,0,Math.PI*2);c.fill();
  drawBunny(c,142,216,62,1,-.2);drawBunny(c,366,216,64,3,.16);drawBunny(c,255,172,96,0,-.04);
  c.fillStyle='#d88ca2';c.font='26px serif';c.fillText('♡',73,115);c.fillText('♡',421,161);
  c.fillStyle='#e7bf71';c.font='22px serif';c.fillText('✦',393,80);c.fillText('✦',102,172);
}
resize();
if(saved?.game && world.restore(saved.game) && world.phase==='playing'){
  started=true; $('welcome').hidden=true; $('pause-button').disabled=false;
  world.bodies.forEach(b=>unlock(b.level));setPause(true);
}else { world.reset();world.paused=true;$('pause-button').disabled=true; }
$('best').textContent=best;
function refreshArtwork(progress) {
  if (progress && progress.loaded === progress.total && $('load-status')) {
    $('load-status').textContent = '拖动瞄准 · 松手落下';
  }
  sprites.forEach((image, level) => {
    const context = image.getContext('2d'); context.clearRect(0, 0, image.width, image.height);
    drawBunny(context, spriteHalfSize, spriteHalfSize, SPRITE_RADIUS, level);
  });
  welcomeArt(); updateCollection(); lastNext = -1; updateStats();
  drawTinyBunny($('brand-art'),0);
  const iconCanvas=document.createElement('canvas');iconCanvas.width=iconCanvas.height=128;drawTinyBunny(iconCanvas,0);
  document.querySelector('link[rel="icon"]').href=iconCanvas.toDataURL();
  document.querySelector('link[rel="apple-touch-icon"]').href=iconCanvas.toDataURL();
  if ($('game-dialog').open && $('collection-grid')) {
    Array.from($('collection-grid').querySelectorAll('canvas')).forEach((icon,level)=>drawTinyBunny(icon,level));
  }
  if ($('result-art')) drawTinyBunny($('result-art'),Math.max(1,Math.min(unlocked,LAST_LEVEL)));
}
refreshArtwork(); updateSound();
$('start-button').disabled=false;
$('start-button').innerHTML='开始合成 <span aria-hidden="true">♡</span>';
if (window.__bunnyReady) window.__bunnyReady();
loadRabbitAssets(refreshArtwork).then(loaded => {
  const status = $('load-status');
  if (status) status.textContent = loaded ? '拖动瞄准 · 松手落下' : '照片暂未加载好，也可以先玩';
  if (!loaded) toast('兔兔照片加载慢，可以先玩，刷新后重试', 5000);
}).catch(error => console.warn('Rabbit photos could not be decoded', error));
requestAnimationFrame(render);
