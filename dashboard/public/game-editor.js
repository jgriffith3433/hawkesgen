// Hawkes Play Game Editor
// Main application logic for the collaborative game builder

const API_BASE = window.location.origin;
let currentUser = null;
let currentGame = null;
let openFiles = new Map(); // path -> { content, modified }
let activeFilePath = null;
let monacoEditor = null;
let templates = [];
let saveTimeout = null;

// ====================================================================
// Auth & Initialization
// ====================================================================

async function init() {
  try {
    const res = await fetch(`${API_BASE}/v1/users/me`, { credentials: 'include' });
    if (!res.ok) {
      showAuth();
      return;
    }
    currentUser = await res.json();
    showApp();
    loadGames();
    loadTemplates();
    initMonaco();
  } catch (err) {
    console.error('Init error:', err);
    showAuth();
  }
}

function showAuth() {
  document.getElementById('authScreen').classList.add('show');
  document.getElementById('appContainer').classList.remove('show');
}

function showApp() {
  document.getElementById('authScreen').classList.remove('show');
  document.getElementById('appContainer').classList.add('show');
  document.getElementById('userEmail').textContent = currentUser.email;
  document.getElementById('creditsDisplay').textContent = `⚡ ${currentUser.credits} Credits`;
}

// Auth form handling
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    document.getElementById('nameField').style.display = mode === 'signup' ? 'block' : 'none';
    document.getElementById('authSubmit').textContent = mode === 'signup' ? 'Sign Up' : 'Sign In';
  });
});

document.getElementById('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = document.querySelector('.auth-tab.active').dataset.mode;
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const name = document.getElementById('authName').value;

  const errorEl = document.getElementById('authError');
  errorEl.classList.remove('show');

  try {
    const endpoint = mode === 'signup' ? '/v1/auth/signup' : '/v1/auth/login';
    const body = mode === 'signup' ? { email, password, name } : { email, password };

    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Authentication failed');
    }

    const data = await res.json();
    currentUser = data.user;
    showApp();
    loadGames();
    loadTemplates();
    initMonaco();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.add('show');
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch(`${API_BASE}/v1/auth/logout`, { method: 'POST', credentials: 'include' });
  location.reload();
});

// ====================================================================
// Games List
// ====================================================================

async function loadGames() {
  try {
    const res = await fetch(`${API_BASE}/v1/games`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load games');
    const data = await res.json();

    const grid = document.getElementById('gamesGrid');
    grid.innerHTML = `
      <div class="game-card new-game-card" onclick="showNewGameModal()">
        <div class="icon">+</div>
        <h3>New Game</h3>
      </div>
    `;

    data.items.forEach(game => {
      const card = document.createElement('div');
      card.className = 'game-card';
      card.innerHTML = `
        <h3>${escapeHtml(game.name)}</h3>
        <p>${escapeHtml(game.description || 'No description')}</p>
        <div class="game-card-footer">
          <span>Updated ${formatDate(game.updated)}</span>
          ${game.published ? '<span style="color: #48bb78;">● Published</span>' : '<span>Draft</span>'}
        </div>
      `;
      card.addEventListener('click', () => openGame(game.id));
      grid.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load games:', err);
  }
}

async function loadTemplates() {
  try {
    const res = await fetch(`${API_BASE}/v1/templates`);
    if (!res.ok) throw new Error('Failed to load templates');
    const data = await res.json();
    templates = data.templates;
  } catch (err) {
    console.error('Failed to load templates:', err);
  }
}

function showNewGameModal() {
  const modal = document.getElementById('newGameModal');
  const grid = document.getElementById('templateGrid');

  grid.innerHTML = '';
  templates.forEach(tpl => {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.dataset.templateId = tpl.id;
    card.innerHTML = `
      <h4>${escapeHtml(tpl.name)}</h4>
      <p>${escapeHtml(tpl.description)}</p>
    `;
    card.addEventListener('click', () => {
      document.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    grid.appendChild(card);
  });

  // Auto-select first template
  if (grid.firstElementChild) {
    grid.firstElementChild.classList.add('selected');
  }

  modal.classList.add('show');
}

document.getElementById('cancelNewGameBtn').addEventListener('click', () => {
  document.getElementById('newGameModal').classList.remove('show');
});

document.getElementById('newGameForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('newGameName').value;
  const slug = document.getElementById('newGameSlug').value;
  const selectedCard = document.querySelector('.template-card.selected');
  if (!selectedCard) {
    alert('Please select a template');
    return;
  }
  const templateId = selectedCard.dataset.templateId;

  try {
    // Create game
    const res = await fetch(`${API_BASE}/v1/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, slug, description: '' })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create game');
    }

    const game = await res.json();

    // Load template
    const tplRes = await fetch(`${API_BASE}/v1/templates/${templateId}`);
    if (!tplRes.ok) throw new Error('Failed to load template');
    const template = await tplRes.json();

    // Create files from template
    for (const [path, content] of Object.entries(template.files)) {
      await fetch(`${API_BASE}/v1/games/${game.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path, content })
      });
    }

    document.getElementById('newGameModal').classList.remove('show');
    document.getElementById('newGameForm').reset();
    openGame(game.id);
  } catch (err) {
    alert(err.message);
  }
});

// Auto-generate slug from name
document.getElementById('newGameName').addEventListener('input', (e) => {
  const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  document.getElementById('newGameSlug').value = slug;
});

// ====================================================================
// Game Editor
// ====================================================================

async function openGame(gameId) {
  try {
    // Load game
    const res = await fetch(`${API_BASE}/v1/games/${gameId}`, { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load game');
    currentGame = await res.json();

    // Load files
    const filesRes = await fetch(`${API_BASE}/v1/games/${gameId}/files`, { credentials: 'include' });
    if (!filesRes.ok) throw new Error('Failed to load files');
    const filesData = await filesRes.json();

    openFiles.clear();
    filesData.files.forEach(file => {
      openFiles.set(file.path, { content: file.content, modified: false, savedContent: file.content });
    });

    // Switch to editor view
    document.getElementById('gamesView').classList.remove('show');
    document.getElementById('editorView').classList.add('show');
    document.getElementById('topBarGameName').textContent = currentGame.name;

    // Render file tree
    renderFileTree();

    // Open first file
    if (openFiles.size > 0) {
      const firstPath = Array.from(openFiles.keys())[0];
      openFile(firstPath);
    }

    // Update preview
    updatePreview();
  } catch (err) {
    console.error('Failed to open game:', err);
    alert(err.message);
  }
}

function renderFileTree() {
  const container = document.getElementById('fileTreeContent');
  container.innerHTML = '';

  const paths = Array.from(openFiles.keys()).sort();
  paths.forEach(path => {
    const item = document.createElement('div');
    item.className = 'file-tree-item';
    if (path === activeFilePath) item.classList.add('active');

    const ext = path.split('.').pop();
    const icon = ext === 'html' ? '📄' : ext === 'js' ? '📜' : ext === 'css' ? '🎨' : '📝';

    item.innerHTML = `<span class="file-icon">${icon}</span> ${path}`;
    item.addEventListener('click', () => openFile(path));
    container.appendChild(item);
  });
}

function openFile(path) {
  activeFilePath = path;
  renderFileTree();

  const file = openFiles.get(path);
  if (!file) return;

  if (monacoEditor) {
    const language = getMonacoLanguage(path);
    const model = monaco.editor.createModel(file.content, language);
    monacoEditor.setModel(model);

    model.onDidChangeContent(() => {
      file.content = model.getValue();
      file.modified = file.content !== file.savedContent;
      scheduleSave(path);
    });
  }

  updateEditorTabs();
}

function updateEditorTabs() {
  const container = document.getElementById('editorTabs');
  container.innerHTML = '';

  openFiles.forEach((file, path) => {
    const tab = document.createElement('button');
    tab.className = 'editor-tab';
    if (path === activeFilePath) tab.classList.add('active');

    tab.innerHTML = `
      ${path}
      ${file.modified ? ' •' : ''}
    `;
    tab.addEventListener('click', () => openFile(path));
    container.appendChild(tab);
  });
}

function getMonacoLanguage(path) {
  const ext = path.split('.').pop();
  const map = {
    'html': 'html',
    'js': 'javascript',
    'css': 'css',
    'json': 'json',
    'md': 'markdown'
  };
  return map[ext] || 'plaintext';
}

function scheduleSave(path) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveFile(path), 1000);
}

async function saveFile(path) {
  const file = openFiles.get(path);
  if (!file || !file.modified) return;

  try {
    const res = await fetch(`${API_BASE}/v1/games/${currentGame.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path, content: file.content })
    });

    if (!res.ok) throw new Error('Failed to save file');

    file.savedContent = file.content;
    file.modified = false;
    updateEditorTabs();

    // Auto-refresh preview if index.html or game.js changed
    if (path === 'index.html' || path === 'game.js') {
      updatePreview();
    }
  } catch (err) {
    console.error('Failed to save file:', err);
  }
}

function updatePreview() {
  if (!currentGame) return;
  const iframe = document.getElementById('previewIframe');
  iframe.src = `/play?game=${currentGame.id}&t=${Date.now()}`;
}

document.getElementById('refreshPreviewBtn').addEventListener('click', updatePreview);

document.getElementById('addFileBtn').addEventListener('click', () => {
  const filename = prompt('Enter filename (e.g., script.js):');
  if (!filename) return;

  if (openFiles.has(filename)) {
    alert('File already exists');
    return;
  }

  openFiles.set(filename, { content: '', modified: true, savedContent: '' });
  renderFileTree();
  openFile(filename);
  saveFile(filename);
});

// ====================================================================
// Monaco Editor Initialization
// ====================================================================

function initMonaco() {
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

  require(['vs/editor/editor.main'], function () {
    monacoEditor = monaco.editor.create(document.getElementById('monacoEditor'), {
      value: '',
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });

    // Add Hawkes Play API autocomplete
    monaco.languages.registerCompletionItemProvider('javascript', {
      provideCompletionItems: (model, position) => {
        const suggestions = [
          {
            label: 'game.scene.addEntity',
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: 'game.scene.addEntity({\n\tname: "${1:entityName}",\n\ttype: "${2:box}",\n\tposition: [${3:0}, ${4:1}, ${5:0}]\n});',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Add a new entity to the scene'
          },
          {
            label: 'game.onUpdate',
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: 'game.onUpdate((deltaTime) => {\n\t${1:// Game logic}\n});',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Register update callback'
          },
          {
            label: 'game.getEntity',
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: 'game.getEntity("${1:entityName}")',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Get entity by name'
          }
        ];
        return { suggestions };
      }
    });
  });
}

// ====================================================================
// AI Assistant
// ====================================================================

const AI_BUTTON_HTML = '<button class="btn btn-sm btn-secondary" id="toggleAiBtn" style="position: fixed; bottom: 20px; right: 20px; z-index: 100; border-radius: 50%; width: 56px; height: 56px; font-size: 24px;">🤖</button>';
document.body.insertAdjacentHTML('beforeend', AI_BUTTON_HTML);

document.addEventListener('click', (e) => {
  if (e.target.id === 'toggleAiBtn') {
    document.getElementById('aiPanel').classList.toggle('show');
  }
  if (e.target.id === 'closeAiBtn') {
    document.getElementById('aiPanel').classList.remove('show');
  }
});

document.getElementById('sendChatBtn').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;

  addChatMessage('user', message);
  input.value = '';

  try {
    // Send to AI (for now, just echo back with API reference)
    const response = await callAI(message);
    addChatMessage('assistant', response);
  } catch (err) {
    addChatMessage('assistant', 'Sorry, I encountered an error. Please try again.');
  }
}

function addChatMessage(role, content) {
  const container = document.getElementById('chatMessages');
  const msg = document.createElement('div');
  msg.className = `chat-message ${role}`;
  msg.textContent = content;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

let chatHistory = [];

async function callAI(message) {
  try {
    const gameContext = currentGame ? {
      gameName: currentGame.name,
      currentFile: activeFilePath,
      currentCode: activeFilePath && openFiles.get(activeFilePath)?.content
    } : {};

    const res = await fetch(`${API_BASE}/v1/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        message,
        gameContext,
        history: chatHistory.slice(-10) // Keep last 10 messages for context
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'AI request failed');
    }

    const data = await res.json();

    // Add to history
    chatHistory.push({ role: 'user', content: message });
    chatHistory.push({ role: 'assistant', content: data.message });

    // If code is provided, offer to insert it
    if (data.code && monacoEditor && activeFilePath) {
      const msg = data.message + '\n\n[Code ready to insert - click here to add to editor]';
      setTimeout(() => {
        const lastMsg = document.querySelector('.chat-message.assistant:last-child');
        if (lastMsg) {
          lastMsg.style.cursor = 'pointer';
          lastMsg.addEventListener('click', () => {
            const model = monacoEditor.getModel();
            if (model) {
              const position = monacoEditor.getPosition();
              model.pushEditOperations(
                [],
                [{ range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '\n' + data.code }],
                () => null
              );
            }
          });
        }
      }, 100);
      return msg;
    }

    // If asset suggestions, offer to generate them
    if (data.suggestedAssets && data.suggestedAssets.length > 0) {
      let msg = data.message + '\n\n' + data.suggestedAssets.map((asset, i) =>
        `[${i + 1}] Generate ${asset.type}: "${asset.prompt}"`
      ).join('\n');
      return msg;
    }

    return data.message;
  } catch (err) {
    console.error('AI error:', err);
    throw err;
  }
}

// ====================================================================
// Utilities
// ====================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ====================================================================
// Start
// ====================================================================

init();
