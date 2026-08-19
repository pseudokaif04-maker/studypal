const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const chips = document.querySelectorAll('.chip');

const tabs = document.querySelectorAll('.tab');
const chatView = document.getElementById('chat');
const suggestions = document.getElementById('suggestions');
const composer = document.getElementById('composer');
const notesPanel = document.getElementById('notes-panel');
const notesInput = document.getElementById('notes-input');
const notesResult = document.getElementById('notes-result');
const btnSummary = document.getElementById('btn-summary');
const btnFlashcards = document.getElementById('btn-flashcards');
const btnQuiz = document.getElementById('btn-quiz');
const btnPdf = document.getElementById('btn-pdf');
const pdfInput = document.getElementById('pdf-input');
const pdfName = document.getElementById('pdf-name');
const btnClearPdf = document.getElementById('btn-clear-pdf');

const history = [];
let busy = false;
let selectedPdf = null;

btnPdf.addEventListener('click', () => pdfInput.click());

pdfInput.addEventListener('change', () => {
  const file = pdfInput.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf') {
    setStatus('Please choose a PDF file.');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    setStatus('PDF is too large. Use a PDF under 20MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    selectedPdf = { name: file.name, data: reader.result.split(',')[1] };
    pdfName.textContent = 'Using: ' + file.name;
    btnClearPdf.hidden = false;
    setStatus('');
  };
  reader.readAsDataURL(file);
});

btnClearPdf.addEventListener('click', () => {
  selectedPdf = null;
  pdfInput.value = '';
  pdfName.textContent = '';
  btnClearPdf.hidden = true;
});

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return withBold.replace(/\n/g, '<br>');
}

function addMessage(role, text, typing) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const label = document.createElement('p');
  label.className = 'msg-label';
  label.textContent = role === 'user' ? 'You' : 'StudyPal';

  const content = document.createElement('div');
  content.className = 'msg-text';
  content.innerHTML = typing ? '&hellip;' : renderMarkdown(text);

  div.appendChild(label);
  div.appendChild(content);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return content;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

async function ask(message) {
  if (busy) return;
  busy = true;
  sendBtn.disabled = true;
  setStatus('');
  input.value = '';
  resizeInput();

  addMessage('user', message);
  const typingEl = addMessage('bot', '', true);
  typingEl.textContent = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      typingEl.textContent = data.error || 'Something went wrong. Please try again.';
      setStatus(data.error || '');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop();

      for (const evt of events) {
        let eventType = 'message';
        let data = '';
        for (const line of evt.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) {
          typingEl.textContent = parsed.error;
          setStatus(parsed.error);
          return;
        }
        if (parsed.text) {
          reply += parsed.text;
          typingEl.innerHTML = renderMarkdown(reply);
          chat.scrollTop = chat.scrollHeight;
        }
        if (eventType === 'done' && parsed.reply) {
          reply = parsed.reply;
        }
      }
    }

    history.push({ role: 'user', text: message });
    history.push({ role: 'assistant', text: reply });
    typingEl.innerHTML = renderMarkdown(reply);
  } catch {
    typingEl.textContent = 'Could not reach the server. Is it still running?';
  } finally {
    busy = false;
    sendBtn.disabled = false;
    input.focus();
    chat.scrollTop = chat.scrollHeight;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (message && !busy) ask(message);
});

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

chips.forEach((chip) => {
  chip.addEventListener('click', () => ask(chip.dataset.prompt));
});

tabs.forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const isNotes = name === 'notes';
  chatView.hidden = isNotes;
  suggestions.hidden = isNotes;
  composer.hidden = isNotes;
  notesPanel.hidden = !isNotes;
  setStatus('');
}

function showLoading(button, label) {
  button.dataset.orig = button.textContent;
  button.textContent = 'Working...';
  button.disabled = true;
  btnSummary.disabled = true;
  btnFlashcards.disabled = true;
  btnQuiz.disabled = true;
  return () => {
    button.textContent = button.dataset.orig;
    btnSummary.disabled = false;
    btnFlashcards.disabled = false;
    btnQuiz.disabled = false;
  };
}

function renderFlashcards(cards) {
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  cards.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="card-inner">
        <div class="card-front">${escapeHtml(card.front || '')}</div>
        <div class="card-back">${escapeHtml(card.back || '')}</div>
      </div>`;
    el.addEventListener('click', () => el.classList.toggle('flipped'));
    grid.appendChild(el);
  });
  const hint = document.createElement('p');
  hint.className = 'quiz-explain';
  hint.textContent = 'Tip: click a card to flip it.';
  notesResult.appendChild(grid);
  notesResult.appendChild(hint);
}

function renderQuiz(questions) {
  const score = document.createElement('p');
  score.className = 'quiz-score';
  score.textContent = 'Answer the questions below.';
  notesResult.appendChild(score);

  questions.forEach((q, qi) => {
    const box = document.createElement('div');
    box.className = 'quiz-card';
    const qEl = document.createElement('p');
    qEl.className = 'quiz-q';
    qEl.textContent = `${qi + 1}. ${q.question || ''}`;
    box.appendChild(qEl);

    let answered = false;
    (q.options || []).forEach((opt, oi) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-opt';
      btn.textContent = opt;
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const options = box.querySelectorAll('.quiz-opt');
        options.forEach((o) => (o.disabled = true));
        if (oi === q.answerIndex) {
          btn.classList.add('correct');
          score.textContent = 'Good job! Keep going.';
        } else {
          btn.classList.add('wrong');
          options[q.answerIndex].classList.add('correct');
          score.textContent = 'Keep going, you are learning.';
        }
        const explain = document.createElement('p');
        explain.className = 'quiz-explain';
        explain.textContent = `Answer: ${options[q.answerIndex].textContent} - ${q.explanation || ''}`;
        box.appendChild(explain);
      });
      box.appendChild(btn);
    });
    notesResult.appendChild(box);
  });
}

async function runNotes(action) {
  const text = notesInput.value.trim();
  if (!text && !selectedPdf) {
    setStatus('Paste some notes or upload a PDF first.');
    return;
  }
  setStatus('');
  notesResult.innerHTML = '';
  const done = showLoading(
    action === 'summary' ? btnSummary : action === 'flashcards' ? btnFlashcards : btnQuiz,
    action
  );

  const loading = document.createElement('div');
  loading.className = 'result-box';
  loading.textContent = 'Reading your notes...';
  notesResult.appendChild(loading);

  try {
    const res = await fetch(selectedPdf ? '/api/notes-pdf' : '/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        selectedPdf ? { data: selectedPdf.data, action } : { text, action }
      ),
    });
    const data = await res.json();
    if (!res.ok) {
      loading.textContent = data.error || 'Something went wrong. Please try again.';
      loading.classList.add('error-box');
      return;
    }
    notesResult.innerHTML = '';

    if (action === 'summary') {
      const box = document.createElement('div');
      box.className = 'result-box';
      box.innerHTML = renderMarkdown(data.result);
      notesResult.appendChild(box);
    } else if (action === 'flashcards') {
      renderFlashcards(Array.isArray(data.result) ? data.result : []);
    } else if (action === 'quiz') {
      renderQuiz(Array.isArray(data.result) ? data.result : []);
    }
  } catch {
    loading.textContent = 'Could not reach the server. Is it still running?';
    loading.classList.add('error-box');
  } finally {
    done();
  }
}

btnSummary.addEventListener('click', () => runNotes('summary'));
btnFlashcards.addEventListener('click', () => runNotes('flashcards'));
btnQuiz.addEventListener('click', () => runNotes('quiz'));