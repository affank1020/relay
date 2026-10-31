import { McpTransport } from '../src/gateway.js';
import { verifyAtlasReadOnlyConnection } from '../src/atlas-smoke.js';

/**
 * Operator-run: npm run atlas:smoke
 * Exits nonzero on authentication/contract errors. Never print raw MCP data,
 * endpoint URLs, tokens, project names, record values or tool descriptions.
 */
const url=process.env.ATLAS_MCP_URL?.trim();
const token=process.env.ATLAS_MCP_TOKEN;
if(!url||!token||!/^[a-f0-9]{64}$/.test(token)){
  process.stderr.write('Atlas smoke requires ATLAS_MCP_URL and a 64-hex ATLAS_MCP_TOKEN.\n');
  process.exitCode=1;
}else{
  let transport:McpTransport|undefined;
  try{
    transport=new McpTransport(url,token);
    const report=await verifyAtlasReadOnlyConnection(transport,
      {projectId:process.env.ATLAS_SMOKE_PROJECT_ID||undefined});
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(report.codeReviews==='not_advertised')
      process.stdout.write('Code Reviews is not advertised to this service credential; no permission has been inferred.\n');
  }catch{
    process.stderr.write('Atlas smoke failed: connection, read permission or response contract check failed. No writes were attempted.\n');
    process.exitCode=1;
  }finally{await transport?.close().catch(()=>{});}
}
