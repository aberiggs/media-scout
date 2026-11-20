import { afterEach, describe, expect, it } from 'vitest';
import { SearchRuntime } from '../src/search/runtime';
import { openSearchStore } from '../src/search/store';
import { defaultSettings } from '../src/search/settings';

const runtimes:SearchRuntime[]=[];
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();});

describe('automation boundary regressions',()=>{
  it('returns promptly from explicit poll while the scheduled observation is still running',async()=>{
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
    const settings=structuredClone(defaultSettings);
    settings.monitoring.enabled=true;
    settings.integrations.sonarr={url:'http://sonarr.test',apiKey:'sonarr-key'};
    const runtime=new SearchRuntime({store:openSearchStore(':memory:'),initialSettings:settings,clients:()=>({sonarr:{
      getSeries:async()=>{enter();await blocked;return[];},getEpisodes:async()=>[],getQueue:async()=>[],
    }})});
    runtimes.push(runtime);

    const scheduled=runtime.runAutomation();
    await entered;
    try{
      let pollSettled=false;
      const poll=runtime.poll().then(result=>{pollSettled=true;return result;});
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(pollSettled).toBe(true);
      await expect(poll).resolves.toMatchObject({ran:false,reason:'already-running'});
    }finally{
      release();
      await scheduled;
    }
    await expect(scheduled).resolves.toMatchObject({ran:false});
  });
});
