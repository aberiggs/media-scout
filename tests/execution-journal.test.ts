import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchStore } from '../src/search/store';

describe('execution journal', () => {
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
