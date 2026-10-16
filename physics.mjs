import Matter from './vendor/matter.mjs';
import { RABBIT_SHAPES, getRabbitShape } from './rabbit-shapes.mjs';

const Body = Matter.Body, Composite = Matter.Composite, Engine = Matter.Engine, Sleeping = Matter.Sleeping;
const RADII = [18,23,29,36,43,51,60,70,81,93,106,120];
const COLORS = ['#fff6e7','#d7aa7a','#c8cbd0','#e5b48e','#fffdf2','#c3b6a6','#fff9ee','#f3eadb','#ffffff','#d8bb8d','#c8c1d1','#fff9f0'];
export const LEVELS = Object.freeze(RABBIT_SHAPES.map((shape, level) => Object.freeze({
  name:shape.name, radius:RADII[level], color:COLORS[level], points:2 ** (level+1),
})));

const FIXED_DT = 1/120;
const DROP_DELAY = .42;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finiteIn = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const integerIn = (value, min, max) => Number.isInteger(value) && finiteIn(value, min, max);
const normalizedAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const BODY_OPTIONS = {friction:.55, frictionStatic:.85, frictionAir:.025, restitution:.12, density:.001, slop:.035, sleepThreshold:45};

export class GameWorld {
  constructor(options={}) {
    Object.assign(this, {
      width:options.width===undefined ? 360 : options.width,
      height:options.height===undefined ? 530 : options.height,
      onMerge:options.onMerge, onGameOver:options.onGameOver, onWin:options.onWin,
      random:options.random===undefined ? Math.random : options.random,
    });
    this.dangerY = 115;
    this.reset();
  }

  reset() {
    if (this.engine) Engine.clear(this.engine);
    this.engine = Engine.create({enableSleeping:true, positionIterations:8, velocityIterations:8, constraintIterations:2});
    this.engine.gravity.y = 1.15;
    this.bodies = [];
    this.known = new Set();
    this.byRigidId = new Map();
    this.walls = [];
    this.buildWalls();
    this.score = 0;
    this.phase = 'playing';
    this.paused = false;
    this.aimX = this.width/2;
    this.currentLevel = this.pickLevel();
    this.nextLevel = this.pickLevel();
    this.cooldown = 0;
    this.dangerTime = this.dangerProgress = this.time = this.accumulator = 0;
    this.won = false;
    this.nextId = 1;
  }

  buildWalls() {
    for (const wall of this.walls) Composite.remove(this.engine.world, wall);
    const options = {isStatic:true, friction:.75, restitution:.1};
    this.walls = [Matter.Bodies.rectangle(-50, this.height/2-400, 100, this.height+2000, options),
      Matter.Bodies.rectangle(this.width+50, this.height/2-400, 100, this.height+2000, options),
      Matter.Bodies.rectangle(this.width/2, this.height+50, this.width+200, 100, options)];
    Composite.add(this.engine.world, this.walls);
  }

  pickLevel() {
    const n = this.random();
    return n<.48 ? 0 : n<.79 ? 1 : n<.95 ? 2 : 3;
  }

  get canDrop() {
    return this.phase==='playing' && !this.paused && this.cooldown<=1e-8 && this.bodies.length<100;
  }

  makeBody(level, x, y, vx=0, vy=0, age=0) {
    const radius = LEVELS[level].radius;
    const shape = getRabbitShape(level);
    const parts = shape.parts.map(part => Body.create({...BODY_OPTIONS,
      position:{x:part.x*radius, y:part.y*radius},
      vertices:part.vertices.map(p=>({x:p.x*radius,y:p.y*radius})),
      label:part.kind,
    }));
    const rigid = Body.create({...BODY_OPTIONS, parts, label:`rabbit-${level}`});
    Body.setPosition(rigid, {x,y});
    Body.setVelocity(rigid, {x:vx/60,y:vy/60});
    const wake = () => Sleeping.set(rigid, false);
    const wrapper = {
      id:this.nextId++, level, radius, age,
      get x() {return rigid.position.x;},
      set x(value) {wake(); Body.setPosition(rigid, {x:value,y:rigid.position.y});},
      get y() {return rigid.position.y;},
      set y(value) {wake(); Body.setPosition(rigid, {x:rigid.position.x,y:value});},
      get vx() {return Body.getVelocity(rigid).x*60;},
      set vx(value) {wake(); Body.setVelocity(rigid, {x:value/60,y:Body.getVelocity(rigid).y});},
      get vy() {return Body.getVelocity(rigid).y*60;},
      set vy(value) {wake(); Body.setVelocity(rigid, {x:Body.getVelocity(rigid).x,y:value/60});},
      get angle() {return rigid.angle;},
      set angle(value) {wake(); Body.setAngle(rigid, value);},
      get angularVelocity() {return Body.getAngularVelocity(rigid)*60;},
      set angularVelocity(value) {wake(); Body.setAngularVelocity(rigid, value/60);},
      get isSleeping() {return rigid.isSleeping;},
    };
    Object.defineProperties(wrapper, {
      rigid:{value:rigid},
      parts:{get:()=>rigid.parts.slice(1)},
      bounds:{get:()=>this.getBounds(wrapper)},
    });
    return wrapper;
  }

  getBounds(body) {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (let i=1; i<body.rigid.parts.length; i++) {
      for (const vertex of body.rigid.parts[i].vertices) {
        minX=Math.min(minX,vertex.x); minY=Math.min(minY,vertex.y);
        maxX=Math.max(maxX,vertex.x); maxY=Math.max(maxY,vertex.y);
      }
    }
    return {min:{x:minX,y:minY},max:{x:maxX,y:maxY}};
  }

  syncBodies() {
    const present = new Set(this.bodies);
    for (const body of this.known) {
      if (present.has(body)) continue;
      Composite.remove(this.engine.world, body.rigid);
      this.byRigidId.delete(body.rigid.id);
      this.known.delete(body);
    }
    for (const body of this.bodies) {
      if (this.known.has(body)) continue;
      Composite.add(this.engine.world, body.rigid);
      this.known.add(body);
      this.byRigidId.set(body.rigid.id, body);
    }
  }

  fitBounds(body) {
    const bounds = this.getBounds(body);
    const dx = bounds.min.x<0 ? -bounds.min.x : bounds.max.x>this.width ? this.width-bounds.max.x : 0;
    const dy = bounds.max.y>this.height ? this.height-bounds.max.y : 0;
    if (dx || dy) Body.translate(body.rigid, {x:dx,y:dy});
  }

  drop(x=this.aimX) {
    if (!this.canDrop || !Number.isFinite(x)) return null;
    const radius = LEVELS[this.currentLevel].radius;
    const bounds = getRabbitShape(this.currentLevel).bounds;
    this.aimX = clamp(x, -bounds.minX*radius, this.width-bounds.maxX*radius);
    const body = this.makeBody(this.currentLevel, this.aimX, 74);
    this.bodies.push(body);
    this.syncBodies();
    this.currentLevel = this.nextLevel;
    this.nextLevel = this.pickLevel();
    this.cooldown = DROP_DELAY;
    return body;
  }

  resize(width, height) {
    if (!finiteIn(width,240,1200) || !finiteIn(height,280,1800)) return false;
    if (Math.abs(width-this.width)<.01 && Math.abs(height-this.height)<.01) return true;
    const floorDelta = height-this.height, scaleX = width/this.width;
    this.width = width; this.height = height;
    this.aimX = clamp(this.aimX*scaleX,18,width-18);
    for (const body of this.bodies) {
      const asleep = body.isSleeping;
      Body.setPosition(body.rigid, {x:body.x*scaleX, y:body.y+floorDelta});
      this.fitBounds(body);
      Sleeping.set(body.rigid, asleep);
    }
    this.buildWalls();
    Engine.clear(this.engine);
    this.dangerTime = this.dangerProgress = 0;
    return true;
  }

  snapshot() {
    return {version:2, width:this.width,height:this.height,
      bodies:this.bodies.map(body=>({id:body.id,level:body.level,radius:body.radius,age:body.age,
        x:body.x,y:body.y,vx:body.vx,vy:body.vy,angle:normalizedAngle(body.angle),
        angularVelocity:body.angularVelocity,isSleeping:body.isSleeping})),
      score:this.score,phase:this.phase,currentLevel:this.currentLevel,nextLevel:this.nextLevel,aimX:this.aimX,
      cooldown:this.cooldown,dangerTime:this.dangerTime,time:this.time,won:this.won,nextId:this.nextId};
  }

  restore(data) {
    if (!data || ![1,2].includes(data.version) || !Array.isArray(data.bodies) || data.bodies.length>100) return false;
    if (!finiteIn(data.width,240,1200) || !finiteIn(data.height,280,1800)
      || !integerIn(data.score,0,1e9) || !['playing','over'].includes(data.phase)
      || !integerIn(data.currentLevel,0,3) || !integerIn(data.nextLevel,0,3)
      || !finiteIn(data.aimX,0,data.width) || !finiteIn(data.cooldown,0,DROP_DELAY)
      || !finiteIn(data.dangerTime,0,2.1) || !finiteIn(data.time,0,1e7)
      || typeof data.won!=='boolean' || !integerIn(data.nextId,1,1e9)) return false;
    const ids = new Set();
    for (const body of data.bodies) {
      if (!body || !integerIn(body.id,1,data.nextId-1) || ids.has(body.id)
        || !integerIn(body.level,0,LEVELS.length-1) || !finiteIn(body.x,0,data.width)
        || !finiteIn(body.y,-data.height*2,data.height)
        || !finiteIn(body.vx,-2000,2000) || !finiteIn(body.vy,-2000,2000)
        || !finiteIn(body.age,0,1e7) || !finiteIn(body.angle,-1e9,1e9)
        || !finiteIn(body.angularVelocity,-200,200)
        || (data.version===2 && typeof body.isSleeping!=='boolean')) return false;
      ids.add(body.id);
    }
    // Validation is atomic, and old circular saves migrate to the real rabbit silhouettes.
    const floorDelta = this.height-data.height, scaleX = this.width/data.width;
    const bodies = data.bodies.map(saved=>{
      const body = this.makeBody(saved.level,saved.x*scaleX,saved.y+floorDelta,saved.vx,saved.vy,saved.age);
      body.id = saved.id;
      body.angle = data.version===1 ? clamp(normalizedAngle(saved.angle),-.28,.28) : normalizedAngle(saved.angle);
      body.angularVelocity = data.version===1 ? clamp(saved.angularVelocity,-1.2,1.2) : saved.angularVelocity;
      this.fitBounds(body);
      if (saved.isSleeping) Sleeping.set(body.rigid,true);
      return body;
    });
    this.bodies = bodies;
    this.syncBodies();
    Object.assign(this,{score:data.score,phase:data.phase,currentLevel:data.currentLevel,nextLevel:data.nextLevel,
      aimX:clamp(data.aimX*scaleX,18,this.width-18),cooldown:data.cooldown,
      dangerTime:floorDelta===0 ? data.dangerTime : 0,time:data.time,won:data.won,nextId:data.nextId,
      accumulator:0,paused:false});
    this.dangerProgress = Math.min(1,this.dangerTime/2);
    Engine.clear(this.engine);
    return true;
  }

  step(dt) {
    if (this.paused || this.phase!=='playing' || !Number.isFinite(dt) || dt<=0) return;
    this.accumulator += Math.min(dt,.1);
    while (this.accumulator+1e-10>=FIXED_DT && this.phase==='playing' && !this.paused) {
      this.tick(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    if (this.paused) this.accumulator = 0;
  }

  tick(dt) {
    this.time += dt;
    this.cooldown = Math.max(0,this.cooldown-dt);
    this.syncBodies();
    for (const body of this.bodies) {
      body.age += dt;
      if (body.isSleeping) continue;
      // Damp angular momentum without forcing the physical shape to an upright angle.
      Body.setAngularVelocity(body.rigid,clamp(Body.getAngularVelocity(body.rigid)*Math.exp(-3.5*dt),-.08,.08));
    }
    Engine.update(this.engine,dt*1000);
    // Compound tips can retain a fraction of a pixel of solver slop at the floor.
    // Keep the visible photo outline inside the board without changing its rotation.
    for (const body of this.bodies) this.fitBounds(body);
    this.mergeContacts();
    const overflow = this.bodies.some(body=>body.age>=2.2 && this.getBounds(body).min.y<this.dangerY);
    this.dangerTime = overflow ? this.dangerTime+dt : 0;
    this.dangerProgress = Math.min(1,this.dangerTime/2);
    if (this.dangerTime>=2) {
      this.phase = 'over';
      this.onGameOver?.({score:this.score});
    }
  }

  mergeContacts() {
    const used = new Set(), added = [], events = [];
    let win = false;
    for (const pair of this.engine.pairs.list) {
      if (!pair.isActive) continue;
      const a = this.byRigidId.get(pair.collision.parentA.id), b = this.byRigidId.get(pair.collision.parentB.id);
      if (!a || !b || a===b || used.has(a) || used.has(b) || a.level!==b.level) continue;
      used.add(a); used.add(b);
      const final = a.level===LEVELS.length-1, level = final ? a.level : a.level+1;
      const points = final ? LEVELS[level].points*2 : LEVELS[level].points;
      const x = (a.x+b.x)/2, y = (a.y+b.y)/2;
      this.score += points;
      let bodyId;
      if (!final) {
        // A bounded upward kick makes each merge pop without amplifying a chain reaction.
        const bounceVelocity = -145 + Math.max(-30, Math.min(0, (a.vy+b.vy)*.2));
        const merged = this.makeBody(level,x,y,(a.vx+b.vx)*.35,bounceVelocity,Math.max(a.age,b.age));
        this.fitBounds(merged);
        added.push(merged);
        bodyId = merged.id;
      }
      events.push({x,y,level,points,final,score:this.score,bodyId});
      if (level===LEVELS.length-1 && !this.won) {this.won=true; win=true;}
    }
    if (used.size) {
      this.bodies = this.bodies.filter(body=>!used.has(body)).concat(added);
      this.syncBodies();
    }
    for (const event of events) this.onMerge?.(event);
    if (win) this.onWin?.({score:this.score});
  }
}
