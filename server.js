const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище пользователей
let users = {};

console.log('🚀 Messenger server starting...');

// ============== HTML КЛИЕНТ (встроенный) ==============
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#0e1621">
    <title>Simple Messenger</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }

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
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
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
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        }

        .login-card h2 {
            color: #fff;
            margin-bottom: 8px;
            font-size: 28px;
        }

        .login-card p {
            color: #8e9eae;
            font-size: 14px;
            margin-bottom: 24px;
        }

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

        .login-card input:focus {
            background: #2b3b4c;
            border: 1px solid #2b5278;
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

        .login-card button:active {
            transform: scale(0.98);
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
            flex-shrink: 0;
        }

        .chat-header h2 {
            color: #fff;
            font-size: 18px;
        }

        .header-right {
            display: flex;
            gap: 12px;
            align-items: center;
        }

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
            flex-shrink: 0;
        }

        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            background: #0e1621;
            -webkit-overflow-scrolling: touch;
        }

        .message {
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
            animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message.own {
            align-items: flex-end;
        }

        .message-bubble {
            max-width: 80%;
            padding: 10px 14px;
            border-radius: 18px;
            word-wrap: break-word;
            font-size: 15px;
            line-height: 1.4;
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

        .message-name {
            font-size: 11px;
            color: #8e9eae;
            margin-bottom: 4px;
            margin-left: 8px;
        }

        .message.own .message-name {
            margin-right: 8px;
            margin-left: 0;
        }

        .message-time {
            font-size: 9px;
            color: #6c7a89;
            margin-top: 4px;
            margin-left: 8px;
        }

        .message.own .message-time {
            margin-right: 8px;
            margin-left: 0;
        }

        .input-area {
            background: #17212b;
            padding: 12px 16px;
            display: flex;
            gap: 10px;
            border-top: 1px solid #2b3b4c;
            flex-shrink: 0;
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

        .input-area input:focus {
            background: #2b3b4c;
        }

        .input-area button {
            padding: 12px 20px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-weight: 600;
            font-size: 16px;
            cursor: pointer;
        }

        .input-area button:active {
            transform: scale(0.97);
        }

        .users-panel {
            position: fixed;
            right: 0;
            top: 0;
            bottom: 0;
            width: 260px;
            background: #17212b;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            z-index: 2000;
            box-shadow: -4px 0 12px rgba(0,0,0,0.3);
            display: flex;
            flex-direction: column;
        }

        .users-panel.open {
            transform: translateX(0);
        }

        .users-panel-header {
            padding: 20px;
            border-bottom: 1px solid #2b3b4c;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .users-panel-header h3 {
            color: #fff;
            font-size: 18px;
        }

        .users-panel-header button {
            background: none;
            border: none;
            color: #8e9eae;
            font-size: 24px;
            cursor: pointer;
        }

        .users-list {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }

        .user-item {
            padding: 12px;
            color: #fff;
            border-radius: 12px;
            margin-bottom: 4px;
            background: #242f3e;
            font-size: 14px;
        }

        .user-item.current {
            background: #2b5278;
        }

        .overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 1999;
            display: none;
        }

        .overlay.show {
            display: block;
        }

        @media (max-width: 600px) {
            .users-panel {
                width: 70%;
            }
            .message-bubble {
                max-width: 85%;
            }
        }
    </style>
</head>
<body>

<div class="login-screen" id="loginScreen">
    <div class="login-card">
        <h2>💬 Simple Messenger</h2>
        <p>Введи имя чтобы начать общение</p>
        <input type="text" id="usernameInput" placeholder="Твое имя" maxlength="24" autocomplete="off">
        <button onclick="login()">Войти</button>
    </div>
</div>

<div class="chat-container" id="chatContainer">
    <div class="chat-header">
        <h2>💬 Simple Messenger</h2>
        <div class="header-right">
            <div class="online-badge" id="onlineCount">👥 0</div>
            <button class="users-toggle" style="background:none; border:none; color:#8e9eae; font-size:20px; cursor:pointer;" onclick="toggleUsersPanel()">☰</button>
        </div>
    </div>
    
    <div class="connection-status" id="connStatus">🟡 Подключение...</div>
    
    <div class="messages-area" id="messagesArea"></div>
    
    <div class="input-area">
        <input type="text" id="messageInput" placeholder="Сообщение..." onkeypress="handleKeyPress(event)" autocomplete="off">
        <button onclick="sendMessage()">➤</button>
    </div>
</div>

<div class="overlay" id="overlay" onclick="toggleUsersPanel()"></div>
<div class="users-panel" id="usersPanel">
    <div class="users-panel-header">
        <h3>👥 Онлайн</h3>
        <button onclick="toggleUsersPanel()">✕</button>
    </div>
    <div class="users-list" id="usersListPanel">
        <div style="color:#8e9eae; text-align:center;">Загрузка...</div>
    </div>
</div>

<script>
    let ws = null;
    let currentUser = '';
    let reconnectAttempts = 0;
    let reconnectTimeout = null;
    let pingInterval = null;
    
    const messagesArea = document.getElementById('messagesArea');
    const messageInput = document.getElementById('messageInput');
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${protocol}//${window.location.host}`;
    
    const savedName = localStorage.getItem('messengerUsername');
    if (savedName) {
        document.getElementById('usernameInput').value = savedName;
    }
    
    function login() {
        let name = document.getElementById('usernameInput').value.trim();
        if (!name) {
            alert('Введите имя');
            return;
        }
        if (name.length < 2) {
            alert('Имя должно быть минимум 2 символа');
            return;
        }
        
        currentUser = name;
        localStorage.setItem('messengerUsername', name);
        
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('chatContainer').style.display = 'flex';
        
        connectWebSocket();
        
        setTimeout(() => messageInput.focus(), 300);
    }
    
    function connectWebSocket() {
        const wsUrl = `${WS_URL}?username=${encodeURIComponent(currentUser)}`;
        
        if (ws) {
            try { ws.close(); } catch(e) {}
        }
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            document.getElementById('connStatus').innerHTML = '🟢 Подключено';
            document.getElementById('connStatus').style.background = '#1e4a3b';
            reconnectAttempts = 0;
            
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 25000);
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                switch(data.type) {
                    case 'message':
                        addMessage(data.user, data.text, data.user === currentUser);
                        break;
                    case 'user_list':
                        updateOnlineList(data.users);
                        break;
                    case 'system':
                        addSystemMessage(data.text);
                        break;
                }
            } catch(e) {}
        };
        
        ws.onerror = () => {
            document.getElementById('connStatus').innerHTML = '🔴 Ошибка соединения';
            document.getElementById('connStatus').style.background = '#6b2e2e';
        };
        
        ws.onclose = () => {
            document.getElementById('connStatus').innerHTML = '🔴 Отключено. Переподключение...';
            document.getElementById('connStatus').style.background = '#6b2e2e';
            
            if (pingInterval) clearInterval(pingInterval);
            
            if (reconnectAttempts < 15) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => {
                    reconnectAttempts++;
                    connectWebSocket();
                }, 3000);
            } else {
                addSystemMessage('⚠️ Не удалось подключиться. Обнови страницу.');
            }
        };
    }
    
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'message',
                text: text
            }));
            messageInput.value = '';
        } else {
            addSystemMessage('Нет соединения с сервером');
        }
        
        setTimeout(() => {
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }, 50);
    }
    
    function handleKeyPress(event) {
        if (event.key === 'Enter') {
            sendMessage();
        }
    }
    
    function addMessage(user, text, isOwn) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message' + (isOwn ? ' own' : '');
        const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        messageDiv.innerHTML = \`
            <div class="message-name">\${escapeHtml(user)}</div>
            <div class="message-bubble">\${escapeHtml(text)}</div>
            <div class="message-time">\${time}</div>
        \`;
        
        messagesArea.appendChild(messageDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        
        while (messagesArea.children.length > 500) {
            messagesArea.removeChild(messagesArea.firstChild);
        }
    }
    
    function addSystemMessage(text) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.style.opacity = '0.7';
        messageDiv.style.alignItems = 'center';
        
        messageDiv.innerHTML = \`
            <div class="message-bubble" style="background: #2b3b4c; border-radius: 12px; font-size: 12px;">🔹 \${escapeHtml(text)}</div>
        \`;
        
        messagesArea.appendChild(messageDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }
    
    function updateOnlineList(users) {
        const count = users.length;
        document.getElementById('onlineCount').innerHTML = \`👥 \${count}\`;
        
        const panel = document.getElementById('usersListPanel');
        if (users.length === 0) {
            panel.innerHTML = '<div style="color:#8e9eae; text-align:center;">Никого нет</div>';
        } else {
            let html = '';
            users.forEach(u => {
                const isCurrent = u === currentUser;
                html += \`<div class="user-item\${isCurrent ? ' current' : ''}">\${escapeHtml(u)}\${isCurrent ? ' (вы)' : ''}</div>\`;
            });
            panel.innerHTML = html;
        }
    }
    
    function toggleUsersPanel() {
        const panel = document.getElementById('usersPanel');
        const overlay = document.getElementById('overlay');
        panel.classList.toggle('open');
        overlay.classList.toggle('show');
    }
    
    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const panel = document.getElementById('usersPanel');
            const overlay = document.getElementById('overlay');
            if (panel.classList.contains('open')) {
                panel.classList.remove('open');
                overlay.classList.remove('show');
            }
        }
    });
</script>
</body>
</html>`;

// ============== HTTP РОУТЫ ==============
app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        users: Object.keys(users),
        count: Object.keys(users).length,
        uptime: process.uptime()
    });
});

// ============== WEBSOCKET ЛОГИКА ==============
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
    
    ws.send(JSON.stringify({
        type: 'system',
        text: `Добро пожаловать, ${currentUser}!`
    }));
    
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
                if (users[currentUser]) {
                    users[currentUser].lastPing = Date.now();
                }
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
    broadcast(JSON.stringify({
        type: 'user_list',
        users: userList
    }));
    console.log(`👥 Online: ${userList.length} users`);
}

// ============== ЗАПУСК ==============
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🎉 Server running on port ${PORT}`);
    console.log(`📱 Client: http://localhost:${PORT}`);
});
