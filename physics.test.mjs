import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import { GameWorld, LEVELS } from './physics.mjs';
import { getRabbitShape } from './rabbit-shapes.mjs';

function run(world, seconds) {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) world.step(1 / 60);
}

test('drop clamps to walls and enforces a short input cooldown', () => {
  const world = new GameWorld({ random: () => 0 });
  const first = world.drop(-100);
  assert.ok(Math.abs(world.getBounds(first).min.x) < 1e-6);
  assert.equal(world.drop(300), null);
  run(world, 0.5);
  assert.equal(world.canDrop, true);
  assert.ok(Math.abs(world.getBounds(world.drop(999)).max.x-world.width) < 1e-6);
});

test('gravity settles a rabbit on the floor without penetrating the walls', () => {
  const world = new GameWorld({ random: () => 0 });
  const body = world.drop(180);
  body.vx = 900;
  run(world, 8);
  const bounds = world.getBounds(body);
  assert.ok(bounds.min.x >= -0.1 && bounds.max.x <= world.width+0.1);
  assert.ok(Math.abs(bounds.max.y-world.height) < 0.1);
  assert.ok(Math.abs(body.vy) < 6);
  assert.ok(Number.isFinite(body.x + body.y + body.vx + body.vy));
});

test('matching rabbits merge into exactly one larger rabbit and add points', () => {
  const events = [];
  const world = new GameWorld({ random: () => 0, onMerge: event => events.push(event) });
  world.drop(180);
  run(world, 1.2);
  world.drop(180);
  run(world, 1.2);
  assert.equal(world.bodies.length, 1);
  assert.equal(world.bodies[0].level, 1);
  assert.equal(world.score, LEVELS[1].points);
  assert.equal(events.length, 1);
});

test('pause freezes cooldown and motion', () => {
  const world = new GameWorld({ random: () => 0 });
  const body = world.drop(180);
  world.paused = true;
  run(world, 1);
  assert.equal(body.y, 74);
  assert.equal(world.canDrop, false);
  world.paused = false;
  run(world, 0.5);
  assert.equal(world.canDrop, true);
  assert.ok(body.y > 74);
});

test('a merge gives a gentle bounded upward bounce and then settles', () => {
  const events = [];
  const world = new GameWorld({onMerge: event => events.push(event)});
  world.bodies.push(world.makeBody(0, 170, 300), world.makeBody(0, 180, 300));
  world.step(1 / 120);
  assert.equal(world.bodies.length, 1);
  const merged = world.bodies[0], startY = merged.y;
  assert.equal(events[0].bodyId, merged.id);
  assert.ok(merged.vy >= -175 && merged.vy <= -140, `bounce velocity: ${merged.vy}`);
  run(world, .06);
  assert.ok(merged.y < startY - 4, 'the merge should rise visibly');
  run(world, 8);
  assert.ok(merged.isSleeping);
  assert.ok(Math.abs(merged.angularVelocity) < .001);
  assert.equal(events.length, 1);
  assert.equal(world.score, LEVELS[1].points);
});

test('one rabbit cannot merge twice during a single simulation tick', () => {
  const events = [];
  const world = new GameWorld({ random: () => 0, onMerge: event => events.push(event) });
  world.bodies.push(world.makeBody(0, 170, 450), world.makeBody(0, 180, 450), world.makeBody(0, 190, 450));
  world.step(1 / 120);
  assert.deepEqual(world.bodies.map(body => body.level).sort(), [0, 1]);
  assert.equal(events.length, 1);
  assert.equal(new Set(world.bodies.map(body => body.id)).size, 2);
});

test('the largest pair clears and grants its bonus, with win announced once', () => {
  const events = [];
  let wins = 0;
  const world = new GameWorld({ onMerge: event => events.push(event), onWin: () => wins++ });
  const top=LEVELS.length-1;
  world.bodies.push(world.makeBody(top, 140, 300), world.makeBody(top, 220, 300));
  world.step(1 / 120);
  assert.equal(world.bodies.length, 0);
  assert.equal(world.score, LEVELS[top].points*2);
  assert.equal(events[0].final, true);
  assert.equal(wins, 1);
  world.bodies.push(world.makeBody(top, 140, 300), world.makeBody(top, 220, 300));
  world.step(1 / 120);
  assert.equal(wins, 1);
});

test('stack above danger line must survive the grace period and stay overflowing to end game', () => {
  let endings = 0;
  const world = new GameWorld({ height: 400, onGameOver: () => endings++ });
  // Alternating levels avoid merges and hold the small top rabbit above the danger line.
  world.bodies.push(world.makeBody(9, 180, 300), world.makeBody(8, 180, 114), world.makeBody(0, 180, 10));
  run(world, 2.15);
  assert.equal(world.phase, 'playing');
  run(world, 1.5);
  assert.equal(world.phase, 'playing');
  assert.ok(world.dangerProgress > 0.5);
  run(world, 0.75);
  assert.equal(world.phase, 'over');
  assert.equal(endings, 1);
  assert.equal(world.drop(180), null);
  run(world, 2);
  assert.equal(endings, 1);
});

test('a newborn rabbit briefly crossing the danger line does not end the game', () => {
  const world = new GameWorld({ random: () => 0 });
  world.drop(180);
  run(world, 5);
  assert.equal(world.phase, 'playing');
  assert.equal(world.dangerProgress, 0);
});

test('snapshot restore preserves a live game without sharing mutable bodies', () => {
  const first = new GameWorld({ random: () => 0 });
  first.drop(120);
  run(first, 0.5);
  first.drop(260);
  const saved = first.snapshot();
  const second = new GameWorld();
  assert.equal(second.restore(JSON.parse(JSON.stringify(saved))), true);
  assert.equal(second.score, first.score);
  assert.equal(second.currentLevel, first.currentLevel);
  assert.deepEqual(second.bodies, first.bodies);
  second.bodies[0].x = 42;
  assert.notEqual(first.bodies[0].x, 42);
});

test('restore rejects malformed saves atomically', () => {
  const world = new GameWorld({ random: () => 0 });
  world.drop(180);
  const saved = world.snapshot();
  const invalid = [null, {}, { ...saved, bodies: Array(101).fill(saved.bodies[0]) },
    { ...saved, score: NaN }, { ...saved, currentLevel: 9 },
    { ...saved, bodies: [{ ...saved.bodies[0], x: Infinity }] },
    { ...saved, bodies: [{ ...saved.bodies[0], level: 20 }] },
    { ...saved, bodies: [{ ...saved.bodies[0], y: -2000 }] },
    { ...saved, bodies: [saved.bodies[0], saved.bodies[0]] }];
  for (const data of invalid) {
    assert.equal(world.restore(data), false);
    assert.deepEqual(world.snapshot(), saved);
  }
});

test('resize keeps floor-supported rabbits at the new floor and resets overflow hold', () => {
  const world = new GameWorld({ random: () => 0 });
  const body = world.drop(180);
  run(world, 3);
  world.dangerTime = 1.9;
  world.resize(360, 430);
  assert.ok(Math.abs(world.getBounds(body).max.y-430) < .1);
  assert.equal(world.dangerProgress, 0);
  assert.equal(world.height, 430);
  assert.equal(world.phase, 'playing');
});

test('restoring across viewport heights relocates rabbits relative to the new floor', () => {
  const first = new GameWorld({ random: () => 0 });
  first.drop(180);
  run(first, 3);
  const second = new GameWorld({ height: 430 });
  assert.equal(second.restore(first.snapshot()), true);
  assert.ok(Math.abs(second.getBounds(second.bodies[0]).max.y-430) < .1);
  assert.equal(second.height, 430);
});

test('merge callbacks observe the committed result, and can pause the fixed-step loop', () => {
  let saved;
  const world = new GameWorld({ onMerge: () => { saved = world.snapshot(); world.paused = true; } });
  world.bodies.push(world.makeBody(0, 170, 450), world.makeBody(0, 190, 450));
  world.step(0.1);
  assert.deepEqual(saved.bodies.map(body => body.level), [1]);
  assert.equal(world.time, 1 / 120);
});

test('a sliding irregular rabbit sleeps with no angular velocity after it stops', () => {
  const world = new GameWorld();
  const body = world.makeBody(0, 100, world.height - LEVELS[0].radius, 140);
  world.bodies.push(body);
  run(world, 12);
  assert.ok(Math.hypot(body.vx, body.vy) < 1, 'the rabbit has stopped moving');
  assert.equal(body.angularVelocity, 0, 'resting rabbits must stop spinning');
  assert.equal(body.isSleeping, true);
  const restingAngle = body.angle;
  run(world, 3);
  assert.equal(body.angle, restingAngle, 'natural resting orientation stays stable');
});

test('a settled mixed-level stack sleeps without contact-driven spinning', () => {
  const world = new GameWorld();
  const positions = [[6, 145, 467], [4, 190, 370], [2, 190, 297], [0, 190, 250]];
  for (const [level, x, y] of positions) {
    const body = world.makeBody(level, x, y);
    body.angle = 0.22;
    body.angularVelocity = 0.9;
    world.bodies.push(body);
  }
  run(world, 15);
  assert.equal(world.phase, 'playing');
  assert.equal(world.bodies.length, 4);
  const angles = world.bodies.map(body => body.angle);
  for (const body of world.bodies) {
    assert.equal(body.angularVelocity, 0, 'settled contacts must not reintroduce spin');
    assert.equal(body.isSleeping, true);
  }
  run(world, 3);
  world.bodies.forEach((body, index) => assert.ok(Math.abs(body.angle - angles[index]) < 0.001));
});

test('fast impacts rotate the real silhouette then settle without perpetual spinning', () => {
  const world = new GameWorld();
  const projectile = world.makeBody(0, 80, 350, 550, 50);
  projectile.angularVelocity = 0;
  world.bodies.push(projectile, world.makeBody(3, 250, 430));
  let maximumTilt = 0;
  for (let i = 0; i < 3 * 120; i++) {
    world.step(1 / 120);
    for (const body of world.bodies) {
      maximumTilt = Math.max(maximumTilt, Math.abs(body.angle));
      assert.ok(Number.isFinite(body.angle+body.angularVelocity), 'impact rotation remains finite');
      assert.ok(Math.abs(body.angularVelocity) <= 15, 'impact spin stays bounded');
    }
  }
  assert.ok(maximumTilt > 0.008, 'impacts retain a visible, small wobble');
  assert.equal(world.bodies.length, 2);
  assert.equal(world.score, 0);
  run(world, 10);
  assert.ok(world.bodies.every(body=>body.angularVelocity===0 && body.isSleeping));
});

test('legacy saves with rotated rabbits resume within the new subtle tilt limits', () => {
  const first = new GameWorld({ random: () => 0 });
  first.drop(180);
  const data = first.snapshot();
  data.version = 1;
  data.bodies[0].angle = 24;
  data.bodies[0].angularVelocity = 40;
  const restored = new GameWorld();
  assert.equal(restored.restore(data), true);
  assert.ok(Math.abs(restored.bodies[0].angle) <= 0.28);
  assert.ok(Math.abs(restored.bodies[0].angularVelocity) <= 1.2+1e-8);
  run(restored, 5);
  assert.equal(restored.bodies[0].angularVelocity, 0);
  assert.equal(restored.bodies[0].isSleeping, true);
});

test('rabbit photos use actual convex silhouette parts rather than a circle hull', () => {
  const world = new GameWorld();
  for (let level = 0; level < LEVELS.length; level++) {
    const body = world.makeBody(level, 180, 200);
    assert.ok(body.parts.length >= 3, 'the photo silhouette is a real compound physical body');
    assert.ok(body.parts.every(part => !part.circleRadius), 'all collision parts are polygons');
    const bounds = world.getBounds(body);
    const shape = getRabbitShape(level);
    assert.ok(Math.abs(bounds.min.x - (body.x + shape.bounds.minX * body.radius)) < 0.001);
    assert.ok(Math.abs(bounds.max.y - (body.y + shape.bounds.maxY * body.radius)) < 0.001);
  }
});

test('a photo silhouette protrusion merges rabbits even when their nominal circles do not touch', () => {
  const world = new GameWorld();
  const radius = LEVELS[0].radius;
  const vertices=getRabbitShape(0).parts.flatMap(part=>part.vertices);
  const furthest=vertices.reduce((a,b)=>Math.hypot(a.x,a.y)>Math.hypot(b.x,b.y)?a:b);
  // Mirror the other bunny so their real protruding edges meet beyond the nominal circles.
  const upper = world.makeBody(0, 180, 250);
  const lower = world.makeBody(0, 180+furthest.x*radius*1.98, 250+furthest.y*radius*1.98);
  lower.angle=Math.PI;
  world.bodies.push(upper, lower);
  assert.ok(Math.hypot(lower.x-upper.x, lower.y-upper.y) > 2*radius);
  world.step(1/120);
  assert.equal(world.bodies.length, 1);
  assert.equal(world.bodies[0].level, 1);
});

test('overlapping nominal circles do not merge when the real silhouettes have a gap', () => {
  const world = new GameWorld();
  const radius = LEVELS[0].radius;
  // The upright photo silhouettes have a side-to-side gap inside overlapping nominal circles.
  world.bodies.push(world.makeBody(0, 140, 300), world.makeBody(0, 140+radius*1.8, 300));
  world.step(1/120);
  assert.equal(world.bodies.length, 2);
  assert.equal(world.score, 0);
});

test('a naturally tilted sleeping rabbit keeps its rotation and sleeping state across saves', () => {
  const first = new GameWorld();
  first.bodies.push(first.makeBody(2, 110, 400, 120));
  run(first, 8);
  const old = first.bodies[0];
  assert.equal(old.isSleeping,true);
  const second = new GameWorld();
  assert.equal(second.restore(first.snapshot()),true);
  const restored = second.bodies[0];
  assert.ok(Math.abs(restored.angle-normalized(old.angle))<1e-8);
  assert.equal(restored.isSleeping,true);
  const before = restored.angle;
  run(second,3);
  assert.equal(restored.angle,before);
  assert.equal(restored.angularVelocity,0);
});

function normalized(angle) {return Math.atan2(Math.sin(angle),Math.cos(angle));}

test('all twelve selected photo rabbits have finite convex silhouette parts at a common scale', () => {
  const names=['奶茶兔','麦麦兔','耳机兔','气鼓兔','糯米兔','功夫兔','炸毛兔','大厨兔','圆滚兔','侠客兔','珍珠兔','躺躺兔'];
  assert.equal(LEVELS.length,12);
  assert.deepEqual(LEVELS.map(level=>level.name),names);
  for(let level=0;level<12;level++) {
    const shape=getRabbitShape(level);
    assert.ok(shape.parts.length>=1 && shape.parts.length<=16);
    assert.ok(shape.source && shape.quality.alphaIoU>=.94);
    assert.ok(Math.abs(Math.max(shape.bounds.maxX-shape.bounds.minX,shape.bounds.maxY-shape.bounds.minY)-2)<.00001);
    for(const part of shape.parts) {
      assert.ok(part.vertices.length>=3);
      for(let i=0;i<part.vertices.length;i++) {
        const a=part.vertices[i],b=part.vertices[(i+1)%part.vertices.length],c=part.vertices[(i+2)%part.vertices.length];
        assert.ok(Number.isFinite(a.x+a.y));
        assert.ok((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)>=-.00001,'Matter parts must remain convex');
      }
    }
  }
});

test('photo alpha and collision silhouettes align using the exact renderer crop and COM transform', () => {
  const sheets=new Map();
  for(let level=0;level<LEVELS.length;level++) {
    const shape=getRabbitShape(level),s=shape.source;
    assert.ok(s,'each photo model supplies renderer placement metadata');
    if(!sheets.has(s.sheetURL))sheets.set(s.sheetURL,readAlphaPNG(new URL('./'+s.sheetURL,import.meta.url)));
    const image=sheets.get(s.sheetURL);
    assert.ok(s.cellX>=0 && s.cellY>=0 && s.cellX+s.width<=image.width && s.cellY+s.height<=image.height);
    let intersection=0,union=0;
    const samples=80;
    for(let y=0;y<samples;y++)for(let x=0;x<samples;x++) {
      const cellX=(x+.5)*s.width/samples,cellY=(y+.5)*s.height/samples;
      const alpha=image.alpha[Math.floor(s.cellY+cellY)*image.width+Math.floor(s.cellX+cellX)]>=90;
      const px=(cellX-s.centerX)*s.scale,py=(cellY-s.centerY)*s.scale;
      const solid=shape.parts.some(part=>pointInside(px,py,part.vertices));
      if(alpha&&solid)intersection++;
      if(alpha||solid)union++;
    }
    assert.ok(intersection/union>.90,`${LEVELS[level].name}: photo and shape need matching positions`);
  }
});

function pointInside(x,y,vertices) {
  let inside=false;
  for(let i=0,j=vertices.length-1;i<vertices.length;j=i++) {
    const a=vertices[i],b=vertices[j];
    if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

function readAlphaPNG(url) {
  const buffer=readFileSync(url),compressed=[];let width,height,channels;
  for(let offset=8;offset<buffer.length;) {
    const length=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8),data=buffer.subarray(offset+8,offset+8+length);
    if(type==='IHDR') {width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);channels=data[9]===6?4:data[9]===4?2:0;assert.ok(channels,'photo atlases must contain alpha');}
    if(type==='IDAT')compressed.push(data);
    offset+=length+12;
  }
  const raw=inflateSync(Buffer.concat(compressed)),stride=width*channels,alpha=new Uint8Array(width*height);
  let previous=new Uint8Array(stride),offset=0;
  for(let y=0;y<height;y++) {
    const filter=raw[offset++],row=new Uint8Array(stride);
    for(let x=0;x<stride;x++) {
      const left=x>=channels?row[x-channels]:0,up=previous[x],diagonal=x>=channels?previous[x-channels]:0;
      let prediction=0;
      if(filter===1)prediction=left;
      if(filter===2)prediction=up;
      if(filter===3)prediction=Math.floor((left+up)/2);
      if(filter===4) {const p=left+up-diagonal,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-diagonal);prediction=a<=b&&a<=c?left:b<=c?up:diagonal;}
      row[x]=(raw[offset++]+prediction)&255;
    }
    for(let x=0;x<width;x++)alpha[y*width+x]=row[x*channels+channels-1];
    previous=row;
  }
  return {width,height,alpha};
}
