/**
 * Deliberately small, dependency-free Markdown subset for untrusted LLM output.
 * Never uses innerHTML: all user/model text is assigned through textContent.
 * Not an HTML renderer; unsupported Markdown remains readable as text.
 */
export type InlineToken={type:'text'|'strong'|'em'|'code'|'link';text:string;href?:string};
export type BlockToken={type:'paragraph'|'heading'|'list'|'quote'|'code';text?:string;level?:number;items?:string[];ordered?:boolean;lang?:string};

export function inlineTokens(source:string):InlineToken[]{
  const parts:InlineToken[]=[];
  const pattern=/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;
  let start=0;
  for(const match of source.matchAll(pattern)){
    const index=match.index??0;
    if(index>start)parts.push({type:'text',text:source.slice(start,index)});
    if(match[1]&&match[2]){
      let href:string|undefined;
      try{const url=new URL(match[2]);if(['https:','http:'].includes(url.protocol))href=url.href;}catch{}
      parts.push(href?{type:'link',text:match[1],href}:{type:'text',text:match[0]});
    }else if(match[3])parts.push({type:'strong',text:match[3]});
    else if(match[4])parts.push({type:'code',text:match[4]});
    else parts.push({type:'em',text:match[5]??match[0]});
    start=index+match[0].length;
  }
  if(start<source.length)parts.push({type:'text',text:source.slice(start)});
  return parts;
}

export function markdownBlocks(input:string):BlockToken[]{
  const lines=input.replace(/\r\n?/g,'\n').split('\n');
  const blocks:BlockToken[]=[];
  for(let i=0;i<lines.length;){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const fence=line.match(/^\s*(```|~~~)([\w+-]*)\s*$/);
    if(fence){
      i++;const content:string[]=[];
      while(i<lines.length && !lines[i].trimStart().startsWith(fence[1]))content.push(lines[i++]);
      if(i<lines.length)i++;
      blocks.push({type:'code',text:content.join('\n'),lang:fence[2]||'text'});continue;
    }
    const h=line.match(/^\s*(#{1,3})\s+(.+)$/);
    if(h){blocks.push({type:'heading',text:h[2],level:h[1].length});i++;continue;}
    if(/^\s*>\s?/.test(line)){
      const a:string[]=[];while(i<lines.length&&/^\s*>\s?/.test(lines[i]))a.push(lines[i++].replace(/^\s*>\s?/,''));blocks.push({type:'quote',text:a.join(' ')});continue;
    }
    const list=line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if(list){
      const ordered=/^\s*\d+\./.test(line),items:string[]=[];
      while(i<lines.length&&new RegExp(ordered?'^\\s*\\d+\\.\\s+':'^\\s*[-*]\\s+').test(lines[i]))
        items.push(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/,''));blocks.push({type:'list',items,ordered});continue;
    }
    const text:string[]=[];
    while(i<lines.length&&lines[i].trim()&&!/^\s*(#{1,3}\s+|>\s?|[-*]\s+|\d+\.\s+|```|~~~)/.test(lines[i]))text.push(lines[i++]);
    if(!text.length){text.push(lines[i++]);}
    blocks.push({type:'paragraph',text:text.join('\n')});
  }
  return blocks;
}

function addInline(parent:HTMLElement,source:string):void{
  for(const token of inlineTokens(source)){
    const type=token.type;
    const child=document.createElement(type==='strong'?'strong':type==='em'?'em':type==='code'?'code':type==='link'?'a':'span');
    child.textContent=token.text;
    if(type==='link'&&token.href){
      const link=child as HTMLAnchorElement;link.href=token.href;link.target='_blank';link.rel='noopener noreferrer';
    }
    parent.append(child);
  }
}

export function renderMarkdown(source:string):HTMLElement{
  const container=document.createElement('div');container.className='markdown';
  for(const block of markdownBlocks(source)){
    if(block.type==='code'){
      const frame=document.createElement('div');frame.className='code-frame';
      const bar=document.createElement('div');bar.className='code-header';
      const label=document.createElement('span');label.textContent=block.lang||'text';
      const button=document.createElement('button');button.type='button';button.textContent='Copy';button.setAttribute('aria-label','Copy code block');
      const code=block.text??'';
      button.onclick=()=>{
        if(typeof navigator==='undefined'||!navigator.clipboard){button.textContent='Unavailable';return;}
        void navigator.clipboard.writeText(code).then(()=>{button.textContent='Copied';},()=>{button.textContent='Copy failed';});
      };
      bar.append(label,button);
      const pre=document.createElement('pre');const inner=document.createElement('code');inner.textContent=code;pre.append(inner);
      frame.append(bar,pre);container.append(frame);
    }else if(block.type==='list'){
      const list=document.createElement(block.ordered?'ol':'ul');for(const text of block.items??[]){const li=document.createElement('li');addInline(li,text);list.append(li);}container.append(list);
    }else{
      const tag=block.type==='heading'?(block.level===1?'h2':'h3'):block.type==='quote'?'blockquote':'p';
      const element=document.createElement(tag);addInline(element,block.text??'');container.append(element);
    }
  }
  return container;
}
