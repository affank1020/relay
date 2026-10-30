const $=id=>document.getElementById(id);
let token='',current=null,history=[],busy=false;
const messages=$('messages');
function element(tag,className,text) { const el=document.createElement(tag);el.className=className;el.textContent=text;return el; }
async function api(path,options={}) {
  const response=await fetch('/api'+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(options.headers||{})}});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Request failed');}
  return response;
}
function bubble(role,text){
  const box=element('div','message '+role,'');
  const heading=element('span','heading',role==='user'?'You':'Relay');
  const body=element('div','text',text);
  box.append(heading,body);messages.append(box);messages.scrollTop=messages.scrollHeight;return body;
}
function render(){
  messages.replaceChildren();
  if(!history.length){
    const empty=element('div','empty','');
    empty.append(element('span','spark','✳'),element('h2','','A fresh conversation.'),element('p','','Pi handles the reasoning loop. Relay manages sessions and the interface.'));
    messages.append(empty);return;
  }
  for(const turn of history)bubble(turn.role,turn.text);
}
function setBusy(v){busy=v;$('new').disabled=v;$('send').disabled=v;$('prompt').disabled=v;$('stop').hidden=!v;$('state').textContent=v?'Thinking…':'Idle';}
async function refresh(){
  const [state,list]=await Promise.all([api('/status').then(r=>r.json()),api('/sessions').then(r=>r.json())]);
  $('model').textContent=state.provider+' · '+state.model;
  $('connection').textContent='Pi connected';
  $('sessions').replaceChildren();
  for(const s of list.sessions){
    const button=element('button','session'+(s.id===current?' selected':''),s.title);
    button.type='button';button.onclick=()=>select(s.id).catch(showError);$('sessions').append(button);
  }
}
async function select(id){
  if(busy)return;
  current=id;
  const data=await api('/sessions/'+id).then(r=>r.json());
  history=data.turns;
  $('title').textContent=data.session.title;
  $('cost').textContent='Session $'+data.session.costUsd.toFixed(4);
  render();await refresh();
}
async function create(){
  if(busy)return;
  const result=await api('/sessions',{method:'POST',body:'{}'}).then(r=>r.json());
  await select(result.session.id);$('prompt').focus();
}
function showError(err){window.alert(err.message||String(err));}
async function submit(event){
  event.preventDefault();if(busy)return;
  const value=$('prompt').value.trim();if(!value)return;
  if(!current)await create();
  $('prompt').value='';
  history.push({role:'user',text:value});
  if(history.length===1)$('title').textContent=value.slice(0,55);
  render();
  const body=bubble('assistant','');let answer='';
  setBusy(true);
  try{
    const response=await api('/sessions/'+current+'/messages',{method:'POST',body:JSON.stringify({message:value})});
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    while(true){
      const next=await reader.read();if(next.done)break;
      buffer+=decoder.decode(next.value,{stream:true});
      const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){
        if(!line.trim())continue;
        const e=JSON.parse(line);
        if(e.type==='delta'){answer+=e.data.text;body.textContent=answer;messages.scrollTop=messages.scrollHeight;}
        if(e.type==='done'){answer=e.data.text;body.textContent=answer;$('cost').textContent='Session $'+e.data.costUsd.toFixed(4);}
        if(e.type==='error')throw new Error(e.data.message);
      }
    }
    history.push({role:'assistant',text:answer});
  }catch(err){body.textContent='Error: '+err.message;history.push({role:'assistant',text:body.textContent});}
  finally{setBusy(false);await refresh().catch(()=>{});$('prompt').focus();}
}
$('loginForm').onsubmit=async e=>{e.preventDefault();token=$('token').value;try{await api('/status');$('login').close();$('token').value='';$('error').textContent='';await refresh();if(!current)await create();}catch(err){$('error').textContent=err.message;}};
$('settings').onclick=()=>{token='';$('login').showModal();};
$('new').onclick=()=>create().catch(showError);
$('form').onsubmit=submit;
$('stop').onclick=()=>{if(current&&busy)api('/sessions/'+current+'/abort',{method:'POST',body:'{}'}).catch(showError);};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('form').requestSubmit();}};
$('login').showModal();
