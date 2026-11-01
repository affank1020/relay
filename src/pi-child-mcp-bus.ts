import type { SubagentsBus } from './pi-subagents-rpc.js';

// Pi creates a NEW EventBus for every DefaultResourceLoader, including every
// pi-subagents child. pi.events therefore cannot deliver a child extension's
// event to the parent's Pi extension. This is a process-local, capability-
// neutral signalling channel shared across independently bundled entrypoints.
// Never put credentials or provider connections on it: the parent broker
// verifies the actual Pi agent/session pairing and its live read-only grants.
const KEY=Symbol.for('relay:pi-child-mcp-bus:v1');

function createBus():SubagentsBus {
  const subscriptions=new Map<string,Set<(data:unknown)=>void>>();
  return {
    on(channel,listener){
      if(!channel.startsWith('relay:child-mcp:'))
        throw new Error('Invalid Relay child MCP event channel');
      const listeners=subscriptions.get(channel)??new Set<(data:unknown)=>void>();
      listeners.add(listener);
      subscriptions.set(channel,listeners);
      return ()=>{
        listeners.delete(listener);
        if(listeners.size===0)subscriptions.delete(channel);
      };
    },
    emit(channel,data){
      if(!channel.startsWith('relay:child-mcp:'))
        throw new Error('Invalid Relay child MCP event channel');
      // A broker can be removed by an earlier callback; copy the subscribers
      // before delivery. Do not forward errors or potentially private data to
      // unrelated Pi sessions.
      for(const listener of [...(subscriptions.get(channel)??[])])
        listener(data);
    }
  };
}

export function sharedPiChildMcpBus():SubagentsBus {
  const globals=globalThis as unknown as Record<symbol,unknown>;
  const existing=globals[KEY] as SubagentsBus|undefined;
  if(existing)return existing;
  const bus=createBus();
  globals[KEY]=bus;
  return bus;
}
