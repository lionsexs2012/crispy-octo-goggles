const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

const SECRET_KEY = crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text || !text.includes(':')) return text;
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

let activeUsers = {};

function broadcast(data) {
    for (let user in activeUsers) {
        if (activeUsers[user] && activeUsers[user].readyState === WebSocket.OPEN) {
            try { activeUsers[user].send(JSON.stringify(data)); } catch(e) {}
        }
    }
}

function sendToUser(username, data) {
    if (activeUsers[username] && activeUsers[username].readyState === WebSocket.OPEN) {
        activeUsers[username].send(JSON.stringify(data));
    }
}

function broadcastUserList() {
    broadcast({ type: 'users', users: Object.keys(activeUsers) });
}

function saveMessage(from, to, text) {
    const encrypted = encrypt(text);
    return new Promise((resolve, reject) => {
        db.run("INSERT INTO messages (from_user, to_user, message) VALUES (?, ?, ?)", [from, to, encrypted], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

function getMessages(user1, user2) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC", [user1, user2, user2, user1], (err, rows) => {
            if (err) reject(err);
            else {
                rows.forEach(row => { row.message = decrypt(row.message); });
                resolve(rows);
            }
        });
    });
}

function getUserChats(username) {
    return new Promise((resolve, reject) => {
        db.all("SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as chat_user FROM messages WHERE from_user = ? OR to_user = ?", [username, username, username], (err, rows) => {
            if (err) reject(err);
            else resolve(rows.map(r => r.chat_user));
        });
    });
}

function addUser(username) {
    return new Promise((resolve) => {
        db.run("INSERT OR IGNORE INTO users (username) VALUES (?)", [username], () => resolve());
    });
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger - Login</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: #17212b;
            padding: 40px 32px;
            border-radius: 28px;
            width: 320px;
            text-align: center;
            box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        }
        .login-container h1 { color: #fff; margin-bottom: 8px; font-size: 28px; }
        .login-container p { color: #8e9eae; margin-bottom: 32px; font-size: 14px; }
        .login-container input {
            width: 100%;
            padding: 14px 16px;
            background: #242f3e;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            outline: none;
            margin-bottom: 16px;
        }
        .login-container button {
            width: 100%;
            padding: 14px;
            background: #2b5278;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .error { color: #e53935; font-size: 12px; margin-top: 12px; }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>🔒 Messenger</h1>
        <p>Enter your name to continue</p>
        <input type="text" id="username" placeholder="Your name" maxlength="24" autocomplete="off">
        <button id="loginBtn">Join</button>
        <div id="error" class="error"></div>
    </div>
    <script>
        const usernameInput = document.getElementById('username');
        const loginBtn = document.getElementById('loginBtn');
        const errorDiv = document.getElementById('error');
        
        function login() {
            const name = usernameInput.value.trim();
            if (!name) { errorDiv.textContent = 'Enter your name'; return; }
            if (name.length < 2) { errorDiv.textContent = 'Name must be at least 2 characters'; return; }
            localStorage.setItem('messenger_user', name);
            window.location.href = '/chat?user=' + encodeURIComponent(name);
        }
        
        loginBtn.onclick = login;
        usernameInput.onkeypress = (e) => { if (e.key === 'Enter') login(); };
        
        const saved = localStorage.getItem('messenger_user');
        if (saved) usernameInput.value = saved;
    </script>
</body>
</html>`;

const CHAT_PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Messenger - Chats</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            overflow: hidden;
        }
        .sidebar {
            width: 320px;
            background: #17212b;
            border-right: 1px solid #2b3b4c;
            display: flex;
            flex-direction: column;
        }
        .sidebar-header {
            padding: 20px 16px;
            border-bottom: 1px solid #2b3b4c;
        }
        .sidebar-header h2 { color: #fff; font-size: 20px; margin-bottom: 8px; }
        .user-info {
            color: #8e9eae;
            font-size: 13px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .logout-btn {
            background: #242f3e;
            padding: 6px 12px;
            border-radius: 16px;
            cursor: pointer;
            font-size: 12px;
        }
        .online-count {
            background: #2b5278;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
        }
        .chats-list { flex: 1; overflow-y: auto; }
        .chat-item {
            padding: 16px;
            cursor: pointer;
            border-bottom: 1px solid #2b3b4c;
        }
        .chat-item:hover { background: #242f3e; }
        .chat-item.active { background: #2b5278; }
        .chat-name { color: #fff; font-weight: 500; margin-bottom: 4px; }
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #0e1621;
        }
        .chat-header {
            background: #17212b;
            padding: 16px 20px;
            border-bottom: 1px solid #2b3b4c;
        }
        .chat-header h3 { color: #fff; font-size: 18px; }
        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        }
        .message {
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
        }
        .message.own { align-items: flex-end; }
        .message-bubble {
            max-width: 70%;
            padding: 10px 14px;
            border-radius: 18px;
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
        .message-time { font-size: 10px; color: #6c7a89; margin-top: 4px; margin-left: 8px; }
        .input-area {
            background: #17212b;
            padding: 16px 20px;
            display: flex;
            gap: 12px;
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
            padding: 12px 24px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            font-weight: 600;
            cursor: pointer;
        }
        .status {
            font-size: 12px;
            padding: 8px 16px;
            text-align: center;
            background: #2b3b4c;
            color: #fff;
        }
        .empty-chat { text-align: center; color: #8e9eae; margin-top: 50px; }
        @media (max-width: 600px) { .sidebar { width: 280px; } }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <h2>💬 Chats</h2>
            <div class="user-info">
                <span id="currentUser"></span>
                <span class="online-count" id="onlineCount">0 online</span>
                <span class="logout-btn" id="logoutBtn">Exit</span>
            </div>
        </div>
        <div class="chats-list" id="chatsList"><div style="padding:20px;color:#8e9eae;text-align:center;">Loading...</div></div>
    </div>
    <div class="main">
        <div class="chat-header"><h3 id="chatTitle">Select a chat</h3></div>
        <div class="status" id="status">Connecting...</div>
        <div class="messages-area" id="messagesArea"><div class="empty-chat">Choose a chat to start messaging</div></div>
        <div class="input-area">
            <input type="text" id="messageInput" placeholder="Type a message..." disabled>
            <button id="sendBtn" disabled>Send</button>
        </div>
    </div>
    <script>
        const urlParams = new URLSearchParams(window.location.search);
        let currentUser = urlParams.get('user');
        if (!currentUser) window.location.href = '/';
        
        let ws = null, currentChat = null, reconnectAttempts = 0, pingInterval = null;
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const WS_URL = protocol + '//' + location.host;
        
        const currentUserSpan = document.getElementById('currentUser');
        const onlineCountSpan = document.getElementById('onlineCount');
        const chatsListDiv = document.getElementById('chatsList');
        const chatTitleSpan = document.getElementById('chatTitle');
        const messagesAreaDiv = document.getElementById('messagesArea');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const statusDiv = document.getElementById('status');
        const logoutBtn = document.getElementById('logoutBtn');
        
        currentUserSpan.textContent = currentUser;
        
        function connect() {
            const wsUrl = WS_URL + '?username=' + encodeURIComponent(currentUser);
            if (ws) try { ws.close(); } catch(e) {}
            ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                statusDiv.innerHTML = '🟢 Connected';
                statusDiv.style.background = '#1e4a3b';
                reconnectAttempts = 0;
                if (pingInterval) clearInterval(pingInterval);
                pingInterval = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
                loadChats();
            };
            ws.onmessage = (e) => {
                try {
                    const data = JSON.parse(e.data);
                    if (data.type === 'message') {
                        if (currentChat === data.from) addMessage(data.from, data.text, false, data.time);
                        loadChats();
                    } else if (data.type === 'users') {
                        onlineCountSpan.innerHTML = (data.users.filter(u => u !== currentUser).length) + ' online';
                        loadChats();
                    } else if (data.type === 'history') displayMessages(data.messages);
                    else if (data.type === 'chats') displayChats(data.chats);
                    else if (data.type === 'system') addSystemMessage(data.text);
                } catch(e) {}
            };
            ws.onerror = () => { statusDiv.innerHTML = '🔴 Connection error'; statusDiv.style.background = '#6b2e2e'; };
            ws.onclose = () => {
                statusDiv.innerHTML = '🔴 Disconnected. Reconnecting...';
                statusDiv.style.background = '#6b2e2e';
                if (pingInterval) clearInterval(pingInterval);
                if (reconnectAttempts < 15) setTimeout(() => { reconnectAttempts++; connect(); }, 3000);
            };
        }
        
        function loadChats() { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_chats' })); }
        
        function displayChats(chats) {
            if (!chatsListDiv) return;
            if (chats.length === 0) { chatsListDiv.innerHTML = '<div style="padding:20px;color:#8e9eae;text-align:center;">No chats yet</div>'; return; }
            let html = '';
            chats.forEach(chat => {
                const isActive = (currentChat === chat);
                html += '<div class="chat-item' + (isActive ? ' active' : '') + '" onclick="selectChat(\'' + escapeHtml(chat) + '\')">';
                html += '<div class="chat-name">' + escapeHtml(chat) + '</div></div>';
            });
            chatsListDiv.innerHTML = html;
        }
        
        function selectChat(username) {
            if (username === currentUser) return;
            currentChat = username;
            chatTitleSpan.innerHTML = 'Chat with ' + escapeHtml(username);
            messagesAreaDiv.innerHTML = '';
            messageInput.disabled = false;
            sendBtn.disabled = false;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_history', with: username }));
            loadChats();
        }
        
        function displayMessages(messages) {
            messagesAreaDiv.innerHTML = '';
            if (messages.length === 0) { messagesAreaDiv.innerHTML = '<div class="empty-chat">No messages yet</div>'; return; }
            messages.forEach(msg => {
                const isOwn = (msg.from_user === currentUser);
                addMessageToContainer(msg.from_user, msg.message, isOwn, msg.created_at);
            });
            messagesAreaDiv.scrollTop = messagesAreaDiv.scrollHeight;
        }
        
        function addMessage(user, text, isOwn, time) { addMessageToContainer(user, text, isOwn, time); messagesAreaDiv.scrollTop = messagesAreaDiv.scrollHeight; }
        
        function addMessageToContainer(user, text, isOwn, timestamp) {
            const div = document.createElement('div');
            div.className = 'message' + (isOwn ? ' own' : '');
            const time = timestamp ? new Date(timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div><div class="message-bubble">' + escapeHtml(text) + '</div><div class="message-time">' + time + '</div>';
            messagesAreaDiv.appendChild(div);
        }
        
        function addSystemMessage(text) {
            const div = document.createElement('div');
            div.style.textAlign = 'center'; div.style.color = '#8e9eae'; div.style.fontSize = '12px'; div.style.padding = '8px';
            div.innerHTML = text;
            messagesAreaDiv.appendChild(div);
            messagesAreaDiv.scrollTop = messagesAreaDiv.scrollHeight;
        }
        
        function sendMessage() {
            const text = messageInput.value.trim();
            if (!text) return;
            if (!currentChat) { addSystemMessage('Select a chat first'); return; }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', text: text, to: currentChat }));
                messageInput.value = '';
                addMessage(currentUser, text, true, new Date());
            } else addSystemMessage('No connection');
        }
        
        function logout() { localStorage.removeItem('messenger_user'); window.location.href = '/'; }
        function handleKeyPress(e) { if (e.key === 'Enter') sendMessage(); }
        function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : m); }
        
        sendBtn.onclick = sendMessage;
        messageInput.onkeypress = handleKeyPress;
        logoutBtn.onclick = logout;
        window.selectChat = selectChat;
        connect();
    </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(LOGIN_PAGE));
app.get('/chat', (req, res) => {
    if (!req.query.user) res.redirect('/');
    else res.send(CHAT_PAGE);
});
app.get('/api/status', (req, res) => res.json({ status: 'ok', users: Object.keys(activeUsers), count: Object.keys(activeUsers).length }));

wss.on('connection', (ws, req) => {
    let currentUser = null, pingInterval = null;
    const url = new URL(req.url, 'http://' + req.headers.host);
    const username = url.searchParams.get('username');
    if (!username || !username.trim()) { ws.close(); return; }
    currentUser = username.trim();
    addUser(currentUser);
    if (activeUsers[currentUser]) { try { activeUsers[currentUser].close(); } catch(e) {} delete activeUsers[currentUser]; }
    activeUsers[currentUser] = ws;
    console.log('✅ ' + currentUser + ' connected');
    ws.send(JSON.stringify({ type: 'system', text: 'Welcome, ' + currentUser + '!' }));
    broadcastUserList();
    pingInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'message' && msg.text && msg.to) {
                await saveMessage(currentUser, msg.to, msg.text);
                if (activeUsers[msg.to]) sendToUser(msg.to, { type: 'message', from: currentUser, text: msg.text, time: Date.now() });
                console.log('📨 ' + currentUser + ' -> ' + msg.to + ': ' + msg.text);
            } else if (msg.type === 'get_history' && msg.with) {
                const history = await getMessages(currentUser, msg.with);
                ws.send(JSON.stringify({ type: 'history', messages: history }));
            } else if (msg.type === 'get_chats') {
                const chats = await getUserChats(currentUser);
                ws.send(JSON.stringify({ type: 'chats', chats: chats }));
            }
        } catch(e) { console.log('Error:', e.message); }
    });
    ws.on('close', () => {
        console.log('❌ ' + currentUser + ' disconnected');
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && activeUsers[currentUser]) { delete activeUsers[currentUser]; broadcastUserList(); }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log('Server running on port ' + PORT);
});
