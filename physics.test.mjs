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

test('a real drop makes a small airborne bounce, a weaker second rebound and eventually sleeps', () => {
  const world=new GameWorld({random:()=>0}),body=world.drop(180),bounces=[];
  let previousVy=0,active=-1;
  for(let i=0;i<8*120;i++) {
    world.step(1/120);
    const gap=world.height-world.getBounds(body).max.y;
    if(previousVy>8 && body.vy< -8 && gap<1) {
      bounces.push({speed:-body.vy,height:gap});active=bounces.length-1;
    }
    if(active>=0)bounces[active].height=Math.max(bounces[active].height,gap);
    previousVy=body.vy;
  }
  assert.ok(bounces.length>=2,'the real collision response should produce a second, smaller rebound');
  assert.ok(bounces[0].height>1 && bounces[0].height<35,`first airborne bounce height: ${bounces[0].height}`);
  assert.ok(bounces[1].speed<bounces[0].speed,'the floor must not add energy to later rebounds');
  assert.ok(bounces[1].height<bounces[0].height);
  assert.equal(body.isSleeping,true);assert.equal(body.angularVelocity,0);
});

test('a substantial landing reports one visible impact per collision start and none while resting', () => {
  const impacts=[];
  let world;
  world=new GameWorld({random:()=>0,onImpact:event=>impacts.push({event:event,time:world.time})});
  const body=world.drop(180);
  run(world,4);
  assert.ok(impacts.length>=1,'falling onto the floor must notify the impact animation');
  const first=impacts[0];
  assert.equal(first.event.bodyId,body.id);
  assert.ok(Number.isFinite(first.event.x+first.event.y));
  assert.ok(Math.abs(first.event.y-world.height)<1,'impact coordinates should mark the real bottom of the silhouette');
  assert.ok(first.event.strength>=.25&&first.event.strength<=1);
  assert.equal(impacts.filter(item=>item.time===first.time&&item.event.bodyId===body.id).length,1,'the compound feet must not create duplicate body impacts');
  const count=impacts.length;
  run(world,4);
  assert.equal(impacts.length,count,'persistent or sleeping contacts must not keep firing impacts');
  assert.equal(body.isSleeping,true);
});

test('falling onto a different rabbit reports an impact above the floor', () => {
  const impacts=[];
  const world=new GameWorld({random:()=>0,onImpact:event=>impacts.push(event)});
  const base=world.makeBody(4,180,400);
  world.bodies.push(base);run(world,4);
  impacts.length=0;
  const falling=world.drop(base.x);
  run(world,1.5);
  assert.ok(impacts.some(event=>event.bodyId===falling.id && event.y<world.height-20),'landing on a pile must produce its own real contact event');
  assert.equal(world.score,0,'the fixture must collide without merging');
});

test('fast descent with only lateral rabbit or wall contacts does not emit a landing impact', () => {
  const impacts=[],world=new GameWorld({onImpact:event=>impacts.push(event)});
  world.bodies.push(world.makeBody(0,140,300,0,400,1),world.makeBody(1,170,320,0,0,1));
  world.step(1/120);
  assert.ok(world.engine.pairs.collisionStart.length>0,'the fixture must make a real side contact');
  assert.ok(world.engine.pairs.collisionStart.every(pair=>Math.abs(pair.collision.normal.y)<=.5));
  assert.equal(impacts.length,0,'a downward velocity alone does not make a lateral contact a landing');
  const wallImpacts=[],wallWorld=new GameWorld({onImpact:event=>wallImpacts.push(event)});
  wallWorld.bodies.push(wallWorld.makeBody(0,5,300,-400,400,1));wallWorld.step(1/120);
  assert.ok(wallWorld.engine.pairs.collisionStart.length>0);
  assert.equal(wallImpacts.length,0);
});

test('same-tick merges never report impacts for consumed rabbits or the newly created rabbit', () => {
  const impacts=[],merges=[];
  let world;
  world=new GameWorld({random:()=>0,onImpact:event=>impacts.push({event:event,time:world.time}),
    onMerge:event=>merges.push({event:event,time:world.time})});
  const first=world.drop(180);run(world,4);impacts.length=0;
  const second=world.drop(first.x);run(world,1.5);
  assert.equal(merges.length,1);
  assert.ok(impacts.every(item=>item.time!==merges[0].time),'merge feedback takes precedence over a stale contact impact');
  assert.ok(impacts.every(item=>item.event.bodyId!==first.id&&item.event.bodyId!==second.id),'removed entities must never reach the impact callback');
});

test('a newborn rabbit in a fast initial overlap does not emit an impact', () => {
  const impacts=[],world=new GameWorld({onImpact:event=>impacts.push(event)});
  const body=world.makeBody(0,180,world.height-10,0,400,0);
  world.bodies.push(body);world.step(1/120);
  assert.equal(impacts.length,0);
});

test('matching rabbits merge into exactly one larger rabbit and add points', () => {
  const events = [];
  const world = new GameWorld({ random: () => 0, onMerge: event => events.push(event) });
  const first=world.drop(180);
  run(world,4);
  assert.equal(first.isSleeping,true,'the collision fixture should aim at a settled rabbit');
  world.drop(first.x);
  run(world,1.5);
  assert.equal(world.bodies.length, 1);
  assert.equal(world.bodies[0].level, 1);
  assert.equal(world.score, LEVELS[1].points);
  assert.equal(events.length, 1);
  assert.equal(events[0].bonusCoins,0);
});

test('each crossed 2000-point milestone grants a revive coin, including multiple milestones in one merge', () => {
  const world = new GameWorld();
  world.score = 1996;
  assert.equal(world.reviveCoins,0);
  world.bodies.push(world.makeBody(0,170,300),world.makeBody(0,180,300));
  world.step(1/120);
  assert.equal(world.score,2000);
  assert.equal(world.reviveCoins,1);
  assert.equal(world.canRevive,false,'coins cannot be spent during active play');
  world.phase='over';
  assert.ok(world.revive());
  assert.equal(world.score,2000,'spending a coin must never deduct points');
  assert.equal(world.reviveCoins,0);
  const top=LEVELS.length-2;
  world.bodies.push(world.makeBody(top,140,300),world.makeBody(top,220,300));
  world.step(1/120);
  assert.equal(world.score,6096);
  assert.equal(world.reviveCoins,2,'newly crossed milestones remain available after an earlier revive');
  world.score=11999;
  assert.equal(world.reviveCoins,4);
  world.score=12000;
  assert.equal(world.reviveCoins,5);
});

test('reviving refuses active rounds, empty boards and rounds without coins without changing state', () => {
  const world = new GameWorld({random:()=>0});
  world.drop(180);
  const cases=[{phase:'over',score:1999},{phase:'playing',score:2000}];
  for(const item of cases) {
    world.phase=item.phase; world.score=item.score;
    const before=world.snapshot();
    assert.equal(world.canRevive,false);
    assert.equal(world.revive(),null);
    assert.deepEqual(world.snapshot(),before);
  }
  world.bodies=[];world.phase='over';world.score=4000;
  const before=world.snapshot();
  assert.equal(world.canRevive,false);
  assert.equal(world.revive(),null);
  assert.deepEqual(world.snapshot(),before);
});

test('reviving removes the actual topmost outline and preserves score and all remaining body state', () => {
  const world = new GameWorld({random:()=>0});
  const small=world.makeBody(0,85,110);
  const tall=world.makeBody(10,220,150);
  tall.angle=.35;
  const other=world.makeBody(2,180,400,27,-8,7);
  world.bodies.push(small,tall,other);world.syncBodies();
  assert.ok(tall.y>small.y,'the removed entity must not simply have the highest centre');
  assert.ok(world.getBounds(tall).min.y<world.getBounds(small).min.y);
  world.score=6000;world.phase='over';world.paused=true;
  world.dangerTime=2;world.dangerProgress=1;world.cooldown=.1;world.accumulator=.02;
  const otherState=world.snapshot().bodies.filter(body=>body.id!==tall.id);
  const current=world.currentLevel,next=world.nextLevel;
  assert.equal(world.canRevive,true,'the game-over dialog pause must not block spending a coin');
  assert.equal(world.revive(),tall);
  assert.equal(world.score,6000);
  assert.equal(world.revivesUsed,1);
  assert.equal(world.reviveCoins,2);
  assert.equal(world.phase,'playing');
  assert.equal(world.paused,true,'dialog controls remain responsible for resuming play');
  assert.equal(world.dangerTime,0);assert.equal(world.dangerProgress,0);
  assert.ok(world.cooldown>=.42);assert.equal(world.accumulator,0);
  assert.equal(world.canDrop,false);
  assert.equal(world.currentLevel,current);assert.equal(world.nextLevel,next);
  assert.deepEqual(world.snapshot().bodies,otherState);
  assert.equal(world.known.has(tall),false);
  assert.equal(world.byRigidId.has(tall.rigid.id),false);
  assert.equal(world.engine.world.bodies.includes(tall.rigid),false);
  assert.equal(world.engine.pairs.list.length,0);
  const before=world.snapshot();
  assert.equal(world.revive(),null,'a double click cannot consume another coin before game over recurs');
  assert.deepEqual(world.snapshot(),before);
});

test('equally high outlines choose the lowest stable ID regardless of body array order', () => {
  const world = new GameWorld();
  const first=world.makeBody(0,80,100),second=world.makeBody(0,260,100);
  assert.equal(world.getBounds(first).min.y,world.getBounds(second).min.y);
  world.bodies.push(second,first);world.score=4000;world.phase='over';
  assert.equal(world.revive(),first);
  world.phase='over';
  assert.equal(world.revive(),second);
  assert.equal(world.reviveCoins,0);
  assert.equal(world.revivesUsed,2);
  assert.equal(world.score,4000);
  assert.equal(world.canRevive,false);
});

test('v4 saves preserve spent coins through repeated restores, including legitimate empty rounds', () => {
  const first = new GameWorld({random:()=>0});
  first.drop(180);first.score=6200;first.phase='over';
  assert.ok(first.revive());
  assert.equal(first.bodies.length,0);
  let data=first.snapshot();
  assert.equal(data.version,4);assert.equal(data.revivesUsed,1);assert.equal(data.bonusCoins,0);
  for(let i=0;i<3;i++) {
    const restored=new GameWorld();
    assert.equal(restored.restore(JSON.parse(JSON.stringify(data))),true);
    assert.equal(restored.score,6200);
    assert.equal(restored.revivesUsed,1);
    assert.equal(restored.reviveCoins,2,'refreshing must not refund a consumed coin');
    assert.equal(restored.bodies.length,0);
    data=restored.snapshot();
  }
});

test('v1 and v2 saves receive milestone coins with no prior revive usage', () => {
  const first = new GameWorld({random:()=>0});first.drop(180);first.score=4500;
  for(const version of [1,2]) {
    const data=first.snapshot();data.version=version;delete data.revivesUsed;
    const restored=new GameWorld();
    assert.equal(restored.restore(data),true);
    assert.equal(restored.revivesUsed,0);
    assert.equal(restored.reviveCoins,2);
    assert.equal(restored.snapshot().version,4);
  }
});

test('v3 and v4 revive usage and sleeping flags are strictly validated before any live state changes', () => {
  const world = new GameWorld({random:()=>0});world.drop(180);world.score=6000;
  const before=world.snapshot();
  const invalid=[-1,.5,NaN,Infinity,'1',null,undefined,4].map(value=>Object.assign({},before,{revivesUsed:value}));
  for(const flag of [undefined,'true',1]) {
    const body=Object.assign({},before.bodies[0],{isSleeping:flag});
    invalid.push(Object.assign({},before,{bodies:[body]}));
  }
  for(const version of [3,4]) for(const item of invalid) {
    const data=Object.assign({},item,{version:version});
    assert.equal(world.restore(data),false);
    assert.deepEqual(world.snapshot(),before,'rejected save data must not partially replace a game');
  }
});

test('starting a fresh round clears both milestone coins and previous revive spending', () => {
  const world = new GameWorld({random:()=>0});world.drop(180);world.score=6000;world.phase='over';
  assert.ok(world.revive());
  assert.equal(world.reviveCoins,2);
  world.reset();
  assert.equal(world.score,0);assert.equal(world.revivesUsed,0);assert.equal(world.bonusCoins,0);assert.equal(world.reviveCoins,0);
  assert.equal(world.canRevive,false);assert.equal(world.phase,'playing');
});

test('a real overflow can spend a milestone coin and resume physics after the input cooldown', () => {
  let endings=0;
  const world=new GameWorld({height:400,onGameOver:()=>endings++});
  world.bodies.push(world.makeBody(9,180,300),world.makeBody(8,180,114),world.makeBody(0,180,10));
  world.score=2000;
  run(world,4.5);
  assert.equal(world.phase,'over');assert.equal(endings,1);assert.equal(world.canRevive,true);
  const removed=world.revive();
  assert.ok(removed);assert.equal(world.reviveCoins,0);assert.equal(world.canDrop,false);
  run(world,.5);
  assert.equal(world.phase,'playing');assert.equal(world.canDrop,true);
  assert.equal(world.score,2000);assert.equal(endings,1);
  assert.ok(world.bodies.every(body=>body.id!==removed.id));
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

test('each final-tier pair clears for exactly 500 points and one bonus coin without a creation announcement', () => {
  const events = [];
  let wins = 0;
  const world = new GameWorld({ onMerge: event => events.push(event), onWin: () => wins++ });
  const top=LEVELS.length-1;
  world.bodies.push(world.makeBody(top, 140, 300), world.makeBody(top, 220, 300));
  world.step(1 / 120);
  assert.equal(world.bodies.length, 0);
  assert.equal(world.score,500);
  assert.equal(world.bonusCoins,1);assert.equal(world.reviveCoins,1);
  assert.equal(events[0].points,500);assert.equal(events[0].bonusCoins,1);
  assert.equal(events[0].final, true);
  assert.equal(wins,0,'clearing the final pair must not replace its reward notification with a creation announcement');
  world.bodies.push(world.makeBody(top, 140, 300), world.makeBody(top, 220, 300));
  world.step(1 / 120);
  assert.equal(world.score,1000);assert.equal(world.bonusCoins,2);assert.equal(world.reviveCoins,2);
  assert.equal(events.length,2);assert.equal(wins,0);
});

test('creating the final-tier bunny announces a win once but only clearing it earns a bonus coin', () => {
  let wins=0;const events=[];
  const world=new GameWorld({onWin:()=>wins++,onMerge:event=>events.push(event)});
  const top=LEVELS.length-1;
  world.bodies.push(world.makeBody(top-1,140,300),world.makeBody(top-1,220,300));
  world.step(1/120);
  assert.equal(wins,1);assert.equal(world.won,true);
  assert.equal(world.bodies[0].level,top);
  assert.equal(events[0].final,false);assert.equal(events[0].bonusCoins,0);
  assert.equal(world.bonusCoins,0);
  world.bodies.push(world.makeBody(top,world.bodies[0].x,world.bodies[0].y));
  world.step(1/120);
  assert.equal(wins,1);assert.equal(world.bodies.length,0);assert.equal(world.bonusCoins,1);
  assert.equal(events[1].final,true);assert.equal(events[1].bonusCoins,1);
});

test('a final pair crossing 2000 points awards both its bonus coin and the score milestone coin atomically', () => {
  let saved;
  const world=new GameWorld({onMerge:()=>{saved=world.snapshot();}}),top=LEVELS.length-1;
  world.score=1500;
  world.bodies.push(world.makeBody(top,140,300),world.makeBody(top,220,300));
  world.step(1/120);
  assert.equal(world.score,2000);assert.equal(world.bonusCoins,1);assert.equal(world.reviveCoins,2);
  assert.equal(saved.score,2000);assert.equal(saved.bonusCoins,1);assert.equal(saved.bodies.length,0);
});

test('four final pairs give four bonus coins plus one 2000-point milestone coin', () => {
  const world=new GameWorld(),top=LEVELS.length-1;
  for(let pair=0;pair<4;pair++) {
    world.bodies.push(world.makeBody(top,140,300),world.makeBody(top,220,300));
    world.step(1/120);
    assert.equal(world.bodies.length,0);
  }
  assert.equal(world.score,2000);assert.equal(world.bonusCoins,4);assert.equal(world.reviveCoins,5);
});

test('multiple compound contacts in one frame grant exactly one final bonus for each consumed pair', () => {
  const events=[],world=new GameWorld({onMerge:event=>events.push(event)}),top=LEVELS.length-1;
  for(const x of [100,140,220,260])world.bodies.push(world.makeBody(top,x,300));
  world.step(1/120);
  assert.equal(world.bodies.length,0);assert.equal(events.length,2);
  assert.equal(world.score,1000);assert.equal(world.bonusCoins,2);assert.equal(world.reviveCoins,2);
  assert.ok(events.every(event=>event.final&&event.points===500&&event.bonusCoins===1));
});

test('v4 restores spent bonus coins without refunding them and v3 migrates with no bonus backfill', () => {
  const world=new GameWorld({random:()=>0}),top=LEVELS.length-1;
  world.bodies.push(world.makeBody(top,140,300),world.makeBody(top,220,300));world.step(1/120);
  world.drop(180);world.phase='over';assert.ok(world.revive());
  assert.equal(world.score,500);assert.equal(world.bonusCoins,1);assert.equal(world.revivesUsed,1);assert.equal(world.reviveCoins,0);
  let saved=world.snapshot();
  for(let i=0;i<3;i++) {
    const restored=new GameWorld();assert.equal(restored.restore(JSON.parse(JSON.stringify(saved))),true);
    assert.equal(restored.score,500);assert.equal(restored.bonusCoins,1);assert.equal(restored.revivesUsed,1);assert.equal(restored.reviveCoins,0);
    saved=restored.snapshot();
  }
  const legacy=Object.assign({},saved,{version:3,score:6200,revivesUsed:1});delete legacy.bonusCoins;
  const restored=new GameWorld();assert.equal(restored.restore(legacy),true);
  assert.equal(restored.score,6200);assert.equal(restored.revivesUsed,1);assert.equal(restored.bonusCoins,0);assert.equal(restored.reviveCoins,2);
  restored.reset();assert.equal(restored.bonusCoins,0);assert.equal(restored.revivesUsed,0);assert.equal(restored.reviveCoins,0);
  world.reset();assert.equal(world.score,0);assert.equal(world.bonusCoins,0);assert.equal(world.revivesUsed,0);assert.equal(world.reviveCoins,0);
});

test('v4 rejects malformed bonus counts or spending above total earned coins atomically', () => {
  const world=new GameWorld(),top=LEVELS.length-1;
  world.bodies.push(world.makeBody(top,140,300),world.makeBody(top,220,300));world.step(1/120);
  const before=world.snapshot();
  const invalid=[-1,.5,NaN,Infinity,'1',null,undefined,2].map(value=>Object.assign({},before,{bonusCoins:value}));
  invalid.push(Object.assign({},before,{revivesUsed:2}));
  for(const data of invalid) {
    assert.equal(world.restore(data),false);assert.deepEqual(world.snapshot(),before);
  }
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

test('restoring a resized sleeping stack wakes its bodies and restarts danger grace without losing score or coins', () => {
  const first=new GameWorld({random:()=>0});
  first.bodies.push(first.makeBody(0,120,90,0,0,4),first.makeBody(1,180,140,0,0,4));
  first.score=6200;first.bonusCoins=2;first.revivesUsed=1;
  const saved=first.snapshot();
  saved.bodies[0].radius/=1.12;
  saved.bodies.forEach(body=>{body.isSleeping=true;});
  saved.dangerTime=1.9;
  const restored=new GameWorld();
  assert.equal(restored.restore(saved),true);
  assert.ok(restored.bodies.every(body=>!body.isSleeping),'the changed body and its sleeping neighbours must all take part in collision solving');
  assert.equal(restored.bodies[0].radius,LEVELS[0].radius);
  assert.equal(restored.score,6200);assert.equal(restored.bonusCoins,2);assert.equal(restored.revivesUsed,1);assert.equal(restored.reviveCoins,4);
  assert.equal(restored.phase,'playing');assert.equal(restored.dangerTime,0);assert.equal(restored.dangerProgress,0);
  run(restored,.1);
  assert.equal(restored.phase,'playing','the old near-expired overflow timer must not immediately end the enlarged game');
  assert.equal(restored.score,6200);assert.equal(restored.reviveCoins,4);
  const ended=new GameWorld();
  assert.equal(ended.restore(Object.assign({},saved,{phase:'over'})),true);
  assert.equal(ended.phase,'over','an already ended round must still offer its normal revive flow');
  assert.equal(ended.canRevive,true);assert.equal(ended.reviveCoins,4);
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
