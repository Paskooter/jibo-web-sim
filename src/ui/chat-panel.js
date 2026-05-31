// Chat tab — the simulator's stand-in for talking to Jibo.
//
// Typing a line simulates speech recognition: the text is logged as a user
// message and handed to the send handler (wired to AsrService.recognize in
// main.js), which delivers it to the skill as recognized speech. Jibo's TTS
// responses are logged back via addJiboMessage().

export function installChatPanel(panelEl) {
  panelEl.innerHTML = '';
  panelEl.classList.add('chat-panel');

  const log = document.createElement('div');
  log.className = 'chat-log';

  const form = document.createElement('form');
  form.className = 'chat-input';
  form.innerHTML = `
    <input type="text" placeholder="Say something to Jibo…" autocomplete="off" />
    <button type="submit">Send</button>
  `;
  const input = form.querySelector('input');

  panelEl.append(log, form);

  let sendHandler = null;
  let enabled = false;
  input.disabled = true;

  function addMessage(who, text) {
    const row = document.createElement('div');
    row.className = `chat-msg chat-${who}`;
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !enabled || !sendHandler) return;
    addMessage('user', text);
    input.value = '';
    sendHandler(text);
  });

  return {
    setSendHandler(fn) {
      sendHandler = fn;
      enabled = true;
      input.disabled = false;
    },
    setPlaceholder: (text) => { if (text) input.placeholder = text; },
    addUserMessage: (text) => addMessage('user', text),
    addJiboMessage: (text) => addMessage('jibo', text),
  };
}
