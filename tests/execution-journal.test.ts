import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';

describe('execution journal', () => {
  it('writes automation grace atomically with sending and clears its own grace on rejection', () => {
    const dir=mkdtempSync(join(tmpdir(),'execution-grace-')),path=join(dir,'search.db');
    let store = openSearchStore(path);
    try {
      const now=1_800_000_000_000;
      store.createExecution({id:'auto-exec',key:'auto-key',hash:'hash',searchId:'auto-search',planId:'plan',version:2,payload:{},children:[{candidateId:'candidate',physicalKey:'physical',state:'prepared'}],owner:'owner',now,leaseUntil:now+30_000});
      const grace={mediaKey:'sonarr:show',graceUntil:now+30*60_000,attempt:{startedAt:now,targetKeys:['episode-1'],failureBackoffMinMs:60_000,failureBackoffMaxMs:10*60_000}};
      store.setAutomationAttempt('episode-1',{lastAttempt:now,failCount:1,deadline:now+120*60_000,graceUntil:0});
      expect(store.updateExecutionChild('auto-exec','owner',now,0,'sending',undefined,grace)).toBe(true);
      store.close();store=openSearchStore(path);
      expect(store.getGrace('media','sonarr:show',now)).toBe(grace.graceUntil);
      expect(store.updateExecutionChild('auto-exec','owner',now+1,0,'rejected',undefined,grace)).toBe(true);
      store.close();store=openSearchStore(path);
      expect(store.recoverExecutions(now+30_000)).toBe(1);
      expect(store.execution('auto-exec')?.outcome).toBe('rejected');
      expect(store.getGrace('media','sonarr:show',now+30_000)).toBeNull();
      expect(store.getAutomationAttempt('episode-1')).toMatchObject({deadline:now+1+2*60_000,failCount:2});
    } finally {store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('retains grace for a possibly accepted send recovered after process restart', () => {
    const dir=mkdtempSync(join(tmpdir(),'execution-recovery-grace-')),path=join(dir,'search.db');
    let store=openSearchStore(path);
    try {
      store.createExecution({id:'auto-crash',key:'crash-key',hash:'hash',searchId:'auto-search',planId:'plan',version:2,payload:{},children:[{candidateId:'candidate',physicalKey:'physical',state:'prepared'}],owner:'owner',now:100,leaseUntil:200});
      store.setAutomationAttempt('movie-7',{lastAttempt:100,failCount:0,deadline:720_000,graceUntil:0});
      store.updateExecutionChild('auto-crash','owner',101,0,'sending',undefined,{mediaKey:'radarr:movie:7',graceUntil:180_000,attempt:{startedAt:100,targetKeys:['movie-7'],failureBackoffMinMs:60_000,failureBackoffMaxMs:600_000}});
      store.close();store=openSearchStore(path);
      expect(store.recoverExecutions(201)).toBe(1);
      expect(store.execution('auto-crash')?.children[0]?.state).toBe('uncertain');
      expect(store.getGrace('media','radarr:movie:7',201)).toBe(180_000);
      expect(store.getAutomationAttempt('movie-7')?.deadline).toBe(180_000);
    } finally {store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('recovers only expired operation ownership and never replays sending children', () => {
    const dir=mkdtempSync(join(tmpdir(),'execution-journal-')),path=join(dir,'search.db');
    let store = openSearchStore(path);
    try {
      store.createExecution({ id: 'op', key: 'key', hash: 'h', searchId: 's', planId: 'p', version: 2, payload: {boundReleases:[{downloadUrl:'private'}]}, children: [
        { candidateId: 'a', physicalKey: 'physical-a', state: 'sending' },
        { candidateId: 'b', physicalKey: 'physical-b', state: 'prepared' },
      ], owner: 'owner', now: 100, leaseUntil: 200 });
      store.close();
      store=openSearchStore(path);
      expect(store.recoverExecutions(199)).toBe(0);
      expect(store.recoverExecutions(200)).toBe(1);
      expect(store.execution('op')?.children.map(child => child.state)).toEqual(['uncertain', 'not-attempted']);
      expect(store.executionByKey('key')?.outcome).toBe('uncertain');
      expect(JSON.stringify(store.executionByKey('key'))).not.toContain('private');
      expect(store.executionByKey('key')?.receipt).toMatchObject({outcome:'uncertain'});
    } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
  });
  it('strips private release locators at terminal state and retains a bounded idempotency tombstone',()=>{
    const store=openSearchStore(':memory:');
    try {
      store.createExecution({id:'terminal',key:'old-key',hash:'hash',searchId:'s',planId:'p',version:2,payload:{boundReleases:[{magnetUrl:'magnet:secret'}]},children:[{candidateId:'c',physicalKey:'p',state:'prepared'}],owner:'owner',now:100,leaseUntil:100_000});
      store.updateExecutionChild('terminal','owner',101,0,'sending');
      store.updateExecutionChild('terminal','owner',102,0,'uncertain');
      store.finishExecution('terminal','owner',103,'uncertain',{outcome:'uncertain'});
      expect(JSON.stringify(store.execution('terminal'))).not.toContain('magnet:secret');
      store.maintain(31*86_400_000);
      expect(store.execution('terminal')).toBeNull();
      expect(store.createExecution({id:'again',key:'old-key',hash:'hash',searchId:'s',planId:'p',version:2,payload:{},children:[{candidateId:'c',physicalKey:'p',state:'prepared'}],owner:'again',now:31*86_400_000,leaseUntil:31*86_400_000+1000})).toBe('conflict');
    } finally {store.close();}
  });
  it('fences an expired owner and atomically reserves overlapping physical releases',()=>{
    const store=openSearchStore(':memory:');
    try {
      const first=store.createExecution({id:'one',key:'one-key',hash:'one-hash',searchId:'s',planId:'p',version:2,payload:{},children:[{candidateId:'a',physicalKey:'same',state:'prepared'}],owner:'owner-a',now:10,leaseUntil:20});
      expect(first).toBe('created');
      expect(store.createExecution({id:'two',key:'two-key',hash:'two-hash',searchId:'s',planId:'p',version:2,payload:{},children:[{candidateId:'b',physicalKey:'same',state:'prepared'}],owner:'owner-b',now:11,leaseUntil:21})).toBe('busy');
      expect(store.updateExecutionChild('one','owner-a',21,0,'sending')).toBe(false);
      expect(store.renewExecution('one','owner-a',21,30)).toBe(false);
    } finally {store.close();}
  });
});
