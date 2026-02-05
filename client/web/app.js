const form = document.getElementById('chat-form');
const promptEl = document.getElementById('prompt');
const messagesEl = document.getElementById('messages');
const modelSel = document.getElementById('model');
const newChatBtn = document.getElementById('new-chat');

// persistent conversation stored in localStorage
const STORAGE_KEY = 'ai_chat_messages_v1';
let messages = [];

function loadMessages(){
  try{ messages = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }catch(e){ messages = []; }
}

function saveMessages(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); }catch(e){/* ignore */}
}

function renderMessages(){
  messagesEl.innerHTML = '';
  for(const m of messages){
    const d = document.createElement('div');
    d.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
    d.textContent = m.content;
    messagesEl.appendChild(d);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

loadMessages();
renderMessages();

// load available models from server and populate selector
async function loadModels(){
  try{
    const resp = await fetch('/api/models');
    if(!resp.ok) throw new Error('Failed to fetch models');
    const json = await resp.json();
    let list = [];
    if(Array.isArray(json)) list = json;
    else if(Array.isArray(json.data)) list = json.data;
    else if(Array.isArray(json.models)) list = json.models;

    // normalize to strings
    const opts = list.map(it => {
      if(typeof it === 'string') return it;
      return it.id || it.name || it.model || JSON.stringify(it);
    }).filter(Boolean);

    modelSel.innerHTML = '';
    if(opts.length){
      for(const id of opts){
        const o = document.createElement('option');
        o.value = id; o.textContent = id;
        modelSel.appendChild(o);
      }
      // restore previously selected model if any
      const saved = localStorage.getItem('ai_chat_selected_model');
      if(saved) modelSel.value = saved;
    }else{
      throw new Error('no models');
    }
  }catch(err){
    // fallback set
    modelSel.innerHTML = '';
    ['gpt-5-mini','gpt-4o-mini','gpt-4o'].forEach(v=>{
      const o = document.createElement('option'); o.value=v; o.textContent=v; modelSel.appendChild(o);
    });
    console.warn('Could not load models, using fallback', err);
  }
}

modelSel.addEventListener('change', ()=>{
  try{ localStorage.setItem('ai_chat_selected_model', modelSel.value); }catch(e){}
});

loadModels();

// New chat button clears conversation
if(newChatBtn){
  newChatBtn.addEventListener('click', ()=>{
    messages = [];
    saveMessages();
    renderMessages();
    promptEl.focus();
  });
}

// Enter to send (Shift+Enter inserts newline)
promptEl.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    if(typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', {cancelable:true}));
  }
});

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const prompt = promptEl.value.trim();
  if(!prompt) return;

  // Disable form during request
  const submitBtn = form.querySelector('button[type="submit"]');
  if(submitBtn) submitBtn.disabled = true;
  promptEl.disabled = true;

  // add user message to conversation
  messages.push({role:'user', content: prompt});
  saveMessages();
  renderMessages();
  promptEl.value = '';

  // add temporary assistant placeholder (only for display, not sent to API)
  messages.push({role:'assistant', content: '...'});
  saveMessages();
  renderMessages();

  // Build messages to send (exclude the placeholder)
  const messagesToSend = messages.slice(0, -1);

  try{
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ model: modelSel.value, messages: messagesToSend })
    });
    if(!resp.ok){
      const txt = await resp.text();
      // replace last assistant placeholder with error
      messages[messages.length-1].content = `Error: ${resp.status} ${txt}`;
      saveMessages();
      renderMessages();
      return;
    }

    const data = await resp.json();
    // extract assistant content from common API shapes
    let content = '';
    try{
      const choices = data.choices || [];
      if(choices.length && choices[0].message) content = choices[0].message.content || '';
      else if(choices.length && choices[0].delta) content = choices.map(c=>c.delta?.content||'').join('');
      else if(data.text) content = data.text;
      else content = JSON.stringify(data);
    }catch(e){ content = JSON.stringify(data) }

    // replace placeholder with real assistant message
    messages[messages.length-1].content = content;
    saveMessages();
    renderMessages();
  }catch(err){
    messages[messages.length-1].content = 'Network error';
    saveMessages();
    renderMessages();
    console.error(err);
  }finally{
    // Re-enable form
    if(submitBtn) submitBtn.disabled = false;
    promptEl.disabled = false;
    promptEl.focus();
  }
});
