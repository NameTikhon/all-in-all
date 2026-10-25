import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoMonitor } from '../web/auto-loop.js';
import { createAutoRecovery } from '../web/auto-recovery.js';
import { createAutoSession } from '../web/auto-session.js';
import { analyze } from '../web/durak.js';

// Captured through the real provider on the user's reported first-move frame.
const firstAttack = {
  confidence:'high', hand:['7S','KS','KD','AD','10C','JC'],
  table:[{attack:'6H',defense:null}], opponentCount:5,
  role:'defend', stockCount:null, trumpCard:'AC', trumpSuit:'C',
  notes:['Счётчик колоды не виден.'],
};
const oldSession = {
  hand:['JC','JD','QC','KS','6H','8H'],table:[],discard:[],knownOpponent:[],
  trumpSuit:'H',trumpCard:'JH',opponentCount:6,stockCount:24,
  role:'attack',attackLimit:6,allowTransfer:true,
};
const afterDefense = {
  ...firstAttack, hand:['7S','8H','KS','KD','AD','JC'],
  table:[],opponentCount:6,role:null,stockCount:null,
};

// Advance local sampling without wall-clock sleeps or paid provider calls.
function testClock() {
  let time=0,sequence=0;
  const timers=new Map();
  return {
    now:()=>time,
    setTimer:(callback,delay)=>{const id=++sequence;timers.set(id,{callback,at:time+delay});return id;},
    clearTimer:id=>timers.delete(id),
    async tick(duration) {
      const target=time+duration;
      for(let turns=0;turns<10000;turns++) {
        const next=[...timers.entries()].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next) {time=target;return;}
        time=next[1].at;timers.delete(next[0]);await next[1].callback();
      }
      throw new Error('Automatic monitor did not settle.');
    },
  };
}

function screenshotSequence() {
  const clock=testClock();
  const session=createAutoSession();
  const recovery=createAutoRecovery();
  const observations=[firstAttack,afterDefense,{...afterDefense,hand:null,confidence:'medium'}];
  const signatures=[24,130,230];
  const calls=[],results=[],decisions=[];
  let frame=0,state=null;
  const monitor=createAutoMonitor({
    intervalMs:100,minRequestIntervalMs:1000,stableSamples:2,maxRequests:10,
    capture:async()=>({image:`screen-${frame}`,signature:new Uint8Array(64*36).fill(signatures[frame])}),
    recognize:async(image,context)=>{
      calls.push({image,positionKey:context.positionKey,at:clock.now()});
      return structuredClone(observations[Number(image.slice('screen-'.length))]);
    },
    onResult:(observation,context)=>{
      const result=session.reconcile(state,observation,{initial:state===null,positionKey:context.positionKey});
      const decision=recovery.observe(result,context);
      results.push(result);decisions.push(decision);
      if(result.status==='accepted') state=result.state;
      return decision;
    },
    now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,
  });
  return {clock,monitor,calls,results,decisions,change:index=>{frame=index;},state:()=>state};
}

async function observeFirstMove(previous) {
  let state=previous ? structuredClone(previous) : null;
  const session=createAutoSession();
  const recovery=createAutoRecovery();
  const archives=[];
  const decisions=[];
  let requests=0;
  let resolve;
  const applied=new Promise(done=>{resolve=done;});
  const monitor=createAutoMonitor({
    intervalMs:1,minRequestIntervalMs:0,stableSamples:1,maxRequests:3,
    capture:async()=>({image:'captured-game-window',signature:new Uint8Array(64*36).fill(64)}),
    recognize:async()=>{requests++;return structuredClone(firstAttack);},
    onResult:(observation,context)=>{
      const result=session.reconcile(state,observation,{initial:state===null,positionKey:context.positionKey});
      const decision=recovery.observe(result,context); decisions.push(decision.action);
      if(result.status==='accepted') {
        if(result.newSession) archives.push(structuredClone(state));
        state=result.state; resolve();
      }
      return decision;
    },
  });
  let timeout;
  try {
    monitor.start();
    await Promise.race([applied,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Automatic first move did not apply.')),1500);})]);
    assert.equal(monitor.getState().running,true,'reading a first move must not pause the monitor');
    return {state,archives,decisions,requests};
  } finally {clearTimeout(timeout);monitor.stop();}
}

test('the real first-attack observation produces a legal advice without any manual input',async()=>{
  const result=await observeFirstMove(null);
  assert.equal(result.requests,1);
  assert.deepEqual(result.decisions,['accept']);
  assert.equal(result.state.stockCount,24);
  assert.equal(result.state.role,'defend');
  assert.equal(analyze(result.state).recommendations[0].card,'10C');
});

test('a restored previous game automatically becomes the current first move after one bounded reread',async()=>{
  const original=structuredClone(oldSession);
  const result=await observeFirstMove(oldSession);
  assert.equal(result.requests,2);
  assert.deepEqual(result.decisions,['retry','accept']);
  assert.equal(result.state.trumpCard,'AC');
  assert.deepEqual(result.archives,[original]);
  assert.deepEqual(oldSession,original);
  assert.equal(analyze(result.state).recommendations[0].card,'10C');
});

test('real screenshot sequence continues automatically after our missed defense without charging unchanged frames',async()=>{
  const task=screenshotSequence();
  try {
    task.monitor.start();
    await task.clock.tick(100);
    assert.equal(task.calls.length,1);
    assert.equal(analyze(task.state()).recommendations[0].card,'10C');
    task.change(1);
    await task.clock.tick(1000);
    assert.equal(task.calls.length,2,'the completed defense is one new stable game frame');
    assert.notEqual(task.calls[0].positionKey,task.calls[1].positionKey);
    assert.deepEqual(task.decisions.map(value=>value.action),['accept','accept']);
    assert.deepEqual(task.state().hand,afterDefense.hand);
    assert.deepEqual(task.state().discard,['6H','10C']);
    assert.equal(task.state().stockCount,22);
    assert.equal(task.state().role,'attack');
    assert.ok(analyze(task.state()).recommendations.some(move=>move.type==='attack'),'next-move advice must resume without manual correction');
    await task.clock.tick(60000);
    assert.equal(task.calls.length,2,'repeated identical post-move frames must not buy another recognition');
    assert.equal(task.monitor.getState().running,true);
  } finally {task.monitor.stop();}
});

test('an unreadable frame gets three attempts, preserves confirmed memory, and returning to a resolved frame is free',async()=>{
  const task=screenshotSequence();
  try {
    task.monitor.start();await task.clock.tick(100);
    task.change(1);await task.clock.tick(1000);
    const confirmed=structuredClone(task.state());
    task.change(2);await task.clock.tick(1000);
    assert.equal(task.calls.length,3);
    assert.equal(task.results.at(-1).status,'review');
    assert.equal(task.decisions.at(-1).action,'retry');
    assert.deepEqual(task.state(),confirmed);
    await task.clock.tick(60000);
    assert.equal(task.calls.length,5,'uncertainty receives two rereads with a hard three-read limit');
    assert.equal(task.decisions.at(-1).action,'wait');
    assert.deepEqual(task.state(),confirmed);
    task.change(1);await task.clock.tick(1000);
    assert.equal(task.calls.length,5,'returning to an already checked game frame must be free');
    assert.equal(task.decisions.at(-1).action,'accept','cached observation is reapplied to restore current advice');
    assert.deepEqual(task.state(),confirmed);
    assert.equal(task.monitor.getState().running,true);
  } finally {task.monitor.stop();}
});
