import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piNativeMcpEnabled,piSubagentsEnabled,piChildMcpEnabled } from '../src/pi-mode.js';

test('Pi convergence is off by default and one opt-in switch enables all three paths',()=>{
  const empty={};
  assert.equal(piNativeMcpEnabled(empty),false);
  assert.equal(piSubagentsEnabled(empty),false);
  assert.equal(piChildMcpEnabled(empty),false);
  const enabled={RELAY_PI_FOUNDATION:'1'};
  assert.equal(piNativeMcpEnabled(enabled),true);
  assert.equal(piSubagentsEnabled(enabled),true);
  assert.equal(piChildMcpEnabled(enabled),true);
});
test('Existing per-capability settings remain compatible and never become active from random values',()=>{
  const one={RELAY_PI_NATIVE_MCP:'1'};
  assert.equal(piNativeMcpEnabled(one),true);
  assert.equal(piSubagentsEnabled(one),false);
  assert.equal(piChildMcpEnabled(one),false);
  assert.equal(piNativeMcpEnabled({RELAY_PI_FOUNDATION:'true'}),false);
});
