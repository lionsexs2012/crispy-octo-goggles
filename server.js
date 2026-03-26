const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let users = {};

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Simple Messenger</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .login-screen {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: #0e1621;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .login-card {
            background: #17212b;
            padding: 32px 24px;
            border-radius: 28px;
            width: 85%;
            max-width: 340px;
            text-align: center;
        }
        .login-card h2 { color: #fff; margin-bottom: 8px; font-size: 28px; }
        .login-card p { color: #8e9eae; font-size: 14px; margin-bottom: 24px; }
        .login-card input {
            width: 100%;
            padding: 14px 16px;
            margin: 8px 0;
            background: #242f3e;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            outline: none;
        }
        .login-card button {
            width: 100%;
            padding: 14px;
            background: #2b5278;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            margin-top: 16px;
            cursor: pointer;
        }
        .chat-container {
            display: none;
            flex: 1;
            flex-direction: column;
            height: 100vh;
        }
        .chat-header {
            background: #17212b;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #2b3b4c;
        }
        .chat-header h2 { color: #fff; font-size: 18px; }
        .online-badge {
            background: #2b5278;
            padding: 6px 12px;
            border-radius: 20px;
            color: #fff;
            font-size: 12px;
        }
        .connection-status {
            font-size: 11px;
            padding: 6px;
            text-align: center;
            background: #2b3b4c;
            color: #fff;
        }
        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            background: #0e1621;
        }
        .message {
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
        }
        .message.own { align-items: flex-end; }
        .message-bubble {
            max-width: 80%;
            padding: 10px 14px;
            border-radius: 18px;
            word-wrap: break-word;
            font-size: 15px;
        }
        .message.own .message-bubble {
            background: #2b5278;
            color: #fff;
            border-bottom-right-radius: 4px;
        }
        .message:not(.own) .message-bubble {
            background: #17212b;
            color: #fff;
            border-bottom-left-radius: 4px;
        }
        .message-name { font-size: 11px; color: #8e9eae; margin-bottom: 4px; margin-left: 8px; }
        .message-time { font-size: 9px; color: #6c7a89; margin-top: 4px; margin-left: 8px; }
        .input-area {
            background: #17212b;
            padding: 12px 16px;
            display: flex;
            gap: 10px;
            border-top: 1px solid #2b3b4c;
        }
        .input-area input {
            flex: 1;
            padding: 12px 16px;
            background: #242f3e;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-size: 16px;
            outline: none;
        }
        .input-area button {
            padding: 12px 20px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-weight: 600;
            cursor: pointer;
        }
        .users-panel {
            position: fixed;
            right: 0; top: 0; bottom: 0;
            width: 260px;
            background: #17212b;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            z-index: 2000;
        }
        .users-panel.open { transform: translateX(0); }
        .users-panel-header {
            padding: 20px;
            border-bottom: 1px solid #2b3b4c;
            display: flex;
            justify-content: space-between;
        }
        .users-panel-header h3 { color: #fff; }
        .users-panel-header button { background: none; border: none; color: #8e9eae; font-size: 24px; cursor: pointer; }
        .users-list { padding: 16px; }
        .user-item {
            padding: 12px;
            color: #fff;
            border-radius: 12px;
            margin-bottom: 4px;
            background: #242f3e;
        }
        .user-item.current { background: #2b5278; }
        .overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1999;
            display: none;
        }
        .overlay.show { display: block; }
    </style>
</head>
<body>
<div class="login-screen" id="loginScreen">
    <div class="login-card">
        <h2>💬 Simple Messenger</h2>
        <p>Введи имя чтобы начать общение</p>
        <input type="text" id="usernameInput" placeholder="Твое имя" maxlength="24">
        <button onclick="login()">Войти</button>
    </div>
</div>
<div class="chat-container" id="chatContainer">
    <div class="chat-header">
        <h2>💬 Simple Messenger</h2>
        <div class="online-badge" id="onlineCount">👥 0</div>
        <button style="background:none; border:none; color:#8e9eae; font-size:20px;" onclick="toggleUsersPanel()">☰</button>
    </div>
    <div class="connection-status" id="connStatus">🟡 Подключение...</div>
    <div class="messages-area" id="messagesArea"></div>
    <div class="input-area">
        <input type="text" id="messageInput" placeholder="Сообщение..." onkeypress="handleKeyPress(event)">
        <button onclick="sendMessage()">➤</button>
    </div>
</div>
<div class="overlay" id="overlay" onclick="toggleUsersPanel()"></div>
<div class="users-panel" id="usersPanel">
    <div class="users-panel-header">
        <h3>👥 Онлайн</h3>
        <button onclick="toggleUsersPanel()">✕</button>
    </div>
    <div class="users-list" id="usersListPanel">Загрузка...</div>
</div>
<script>
    let ws = null, currentUser = '', reconnectAttempts = 0, reconnectTimeout = null, pingInterval = null;
    const messagesArea = document.getElementById('messagesArea');
    const messageInput = document.getElementById('messageInput');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${protocol}//${window.location.host}`;
    const savedName = localStorage.getItem('messengerUsername');
    if (savedName) document.getElementById('usernameInput').value = savedName;
    function login() {
        let name = document.getElementById('usernameInput').value.trim();
        if (!name) { alert('Введите имя'); return; }
        if (name.length < 2) { alert('Имя минимум 2 символа'); return; }
        currentUser = name;
        localStorage.setItem('messengerUsername', name);
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('chatContainer').style.display = 'flex';
        connectWebSocket();
        setTimeout(() => messageInput.focus(), 300);
    }
    function connectWebSocket() {
        const wsUrl = `${WS_URL}?username=${encodeURIComponent(currentUser)}`;
        if (ws) { try { ws.close(); } catch(e) {} }
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            document.getElementById('connStatus').innerHTML = '🟢 Подключено';
            document.getElementById('connStatus').style.background = '#1e4a3b';
            reconnectAttempts = 0;
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
        };
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'message') addMessage(data.user, data.text, data.user === currentUser);
                else if (data.type === 'user_list') updateOnlineList(data.users);
                else if (data.type === 'system') addSystemMessage(data.text);
            } catch(e) {}
        };
        ws.onerror = () => { document.getElementById('connStatus').innerHTML = '🔴 Ошибка'; document.getElementById('connStatus').style.background = '#6b2e2e'; };
        ws.onclose = () => {
            document.getElementById('connStatus').innerHTML = '🔴 Отключено. Переподключение...';
            document.getElementById('connStatus').style.background = '#6b2e2e';
            if (pingInterval) clearInterval(pingInterval);
            if (reconnectAttempts < 15) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => { reconnectAttempts++; connectWebSocket(); }, 3000);
            }
        };
    }
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'message', text: text })); messageInput.value = ''; }
        else addSystemMessage('Нет соединения');
        setTimeout(() => messagesArea.scrollTop = messagesArea.scrollHeight, 50);
    }
    function handleKeyPress(e) { if (e.key === 'Enter') sendMessage(); }
    function addMessage(user, text, isOwn) {
        const div = document.createElement('div');
        div.className = 'message' + (isOwn ? ' own' : '');
        const time = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div><div class="message-bubble">' + escapeHtml(text) + '</div><div class="message-time">' + time + '</div>';
        messagesArea.appendChild(div);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        while (messagesArea.children.length > 500) messagesArea.removeChild(messagesArea.firstChild);
    }
    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'message';
        div.style.opacity = '0.7';
        div.style.alignItems = 'center';
        div.innerHTML = '<div class="message-bubble" style="background:#2b3b4c;border-radius:12px;font-size:12px;">🔹 ' + escapeHtml(text) + '</div>';
        messagesArea.appendChild(div);
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }
    function updateOnlineList(users) {
        document.getElementById('onlineCount').innerHTML = '👥 ' + users.length;
        const panel = document.getElementById('usersListPanel');
        if (users.length === 0) panel.innerHTML = '<div style="color:#8e9eae;text-align:center;">Никого нет</div>';
        else { let html = ''; users.forEach(u => { html += '<div class="user-item' + (u === currentUser ? ' current' : '') + '">' + escapeHtml(u) + (u === currentUser ? ' (вы)' : '') + '</div>'; }); panel.innerHTML = html; }
    }
    function toggleUsersPanel() { document.getElementById('usersPanel').classList.toggle('open'); document.getElementById('overlay').classList.toggle('show'); }
    function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, function(m) { if (m === '&') return '&amp;'; if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; return m; }); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById('usersPanel').classList.remove('open'); document.getElementById('overlay').classList.remove('show'); } });
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(users), count: Object.keys(users).length });
});

wss.on('connection', (ws, req) => {
    let currentUser = null;
    let pingInterval = null;
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const username = url.searchParams.get('username');
    
    if (!username || !username.trim()) {
        ws.close();
        return;
    }
    
    currentUser = username.trim();
    
    if (users[currentUser]) {
        try { users[currentUser].ws.close(); } catch(e) {}
        delete users[currentUser];
    }
    
    users[currentUser] = { ws, lastPing: Date.now() };
    console.log(`✅ ${currentUser} connected`);
    
    ws.send(JSON.stringify({ type: 'system', text: `Добро пожаловать, ${currentUser}!` }));
    broadcastUserList();
    
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === 'message' && message.text && message.text.trim()) {
                console.log(`📨 ${currentUser}: ${message.text}`);
                broadcast(JSON.stringify({
                    type: 'message',
                    user: currentUser,
                    text: message.text.trim(),
                    timestamp: Date.now()
                }));
            } else if (message.type === 'ping') {
                if (users[currentUser]) users[currentUser].lastPing = Date.now();
            }
        } catch(e) {}
    });
    
    ws.on('close', () => {
        console.log(`❌ ${currentUser} disconnected`);
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && users[currentUser]) {
            delete users[currentUser];
            broadcastUserList();
        }
    });
});

function broadcast(data) {
    for (let user in users) {
        if (users[user].ws.readyState === WebSocket.OPEN) {
            try { users[user].ws.send(data); } catch(e) {}
        }
    }
}

function broadcastUserList() {
    const userList = Object.keys(users);
    broadcast(JSON.stringify({ type: 'user_list', users: userList }));
    console.log(`👥 Online: ${userList.length}`);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🎉 Server running on port ${PORT}`);
    console.log(`📱 Client: https://crispy-octo-goggles.onrender.com`);
});
