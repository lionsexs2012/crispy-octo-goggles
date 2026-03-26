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
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT,
        to_user TEXT,
        message TEXT,
        file_data TEXT,
        file_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

const ENCRYPTION_KEY = crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    if (!text || !text.includes(':')) return text;
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
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
    broadcast({ type: 'user_list', users: Object.keys(activeUsers) });
}

function saveMessage(from, to, message, fileData = null, fileName = null) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO messages (from_user, to_user, message, file_data, file_name) VALUES (?, ?, ?, ?, ?)`,
            [from, to, message, fileData, fileName],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
}

function getMessages(user1, user2) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC`,
            [user1, user2, user2, user1],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserChats(username) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as chat_user FROM messages WHERE from_user = ? OR to_user = ?`,
            [username, username, username],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserProfile(username) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT username, display_name, bio, avatar FROM users WHERE username = ?`, [username], (err, row) => {
            if (err) reject(err);
            else resolve(row || { username, display_name: username, bio: '', avatar: '👤' });
        });
    });
}

function updateUserProfile(username, data) {
    return new Promise((resolve, reject) => {
        db.run(`UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE username = ?`,
            [data.display_name || username, data.bio || '', data.avatar || '👤', username],
            function(err) { if (err) reject(err); else resolve(this.changes); }
        );
    });
}

function createUser(username) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO users (username, display_name, bio, avatar) VALUES (?, ?, ?, ?)`,
                    [username, username, '', '👤']);
            }
            resolve();
        });
    });
}

// ============== HTML ==============
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Secure Messenger</title>
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
        .profile-btn {
            background: #242f3e;
            padding: 6px 12px;
            border-radius: 20px;
            color: #8e9eae;
            font-size: 12px;
            cursor: pointer;
        }
        .status-bar {
            font-size: 11px;
            padding: 6px;
            text-align: center;
            background: #2b3b4c;
            color: #fff;
        }
        .main-layout {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        .chats-sidebar {
            width: 280px;
            background: #17212b;
            border-right: 1px solid #2b3b4c;
            display: flex;
            flex-direction: column;
        }
        .chats-header {
            padding: 12px 16px;
            border-bottom: 1px solid #2b3b4c;
            color: #8e9eae;
            font-size: 12px;
            font-weight: 600;
        }
        .chats-list {
            flex: 1;
            overflow-y: auto;
        }
        .chat-item {
            padding: 12px 16px;
            cursor: pointer;
            border-bottom: 1px solid #2b3b4c;
        }
        .chat-item:hover { background: #242f3e; }
        .chat-item.active { background: #2b5278; }
        .chat-name { color: #fff; font-weight: 500; }
        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .messages-list {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        }
        .message {
            margin-bottom: 12px;
            display: flex;
            flex-direction: column;
        }
        .message.own { align-items: flex-end; }
        .message-bubble {
            max-width: 70%;
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
        .message-file {
            background: #242f3e;
            padding: 8px 12px;
            border-radius: 12px;
            cursor: pointer;
        }
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
        .file-btn {
            background: #242f3e;
            padding: 12px 16px;
            border-radius: 24px;
            cursor: pointer;
            color: #8e9eae;
        }
        .modal {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.8);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 2000;
        }
        .modal.active { display: flex; }
        .modal-content {
            background: #17212b;
            border-radius: 28px;
            width: 90%;
            max-width: 400px;
            padding: 24px;
        }
        .modal-content h3 { color: #fff; margin-bottom: 20px; }
        .modal-content input, .modal-content textarea {
            width: 100%;
            padding: 12px 16px;
            margin: 8px 0;
            background: #242f3e;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 14px;
            outline: none;
        }
        .modal-content textarea { min-height: 80px; }
        .modal-content button {
            width: 100%;
            padding: 12px;
            background: #2b5278;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-weight: 600;
            margin-top: 12px;
            cursor: pointer;
        }
        .modal-content .close-btn { background: #242f3e; }
        .avatar-preview {
            width: 80px;
            height: 80px;
            border-radius: 40px;
            background: #2b5278;
            margin: 0 auto 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
        }
        @media (max-width: 600px) { .chats-sidebar { width: 240px; } }
    </style>
</head>
<body>

<div class="login-screen" id="loginScreen">
    <div class="login-card">
        <h2>🔒 Secure Messenger</h2>
        <p>Enter your name to start</p>
        <input type="text" id="usernameInput" placeholder="Your name" maxlength="24">
        <button id="joinButton">Join</button>
    </div>
</div>

<div class="chat-container" id="chatContainer">
    <div class="chat-header">
        <h2 id="chatTitle">💬 Secure Messenger</h2>
        <div class="header-right">
            <div class="online-badge" id="onlineCount">0 online</div>
            <div class="profile-btn" id="profileBtn">👤 Profile</div>
        </div>
    </div>
    <div class="status-bar" id="statusBar">Connecting...</div>
    <div class="main-layout">
        <div class="chats-sidebar">
            <div class="chats-header">💬 CHATS</div>
            <div class="chats-list" id="chatsList"></div>
        </div>
        <div class="chat-area">
            <div class="messages-list" id="messagesList"></div>
            <div class="input-area">
                <div class="file-btn" id="fileBtn">📎</div>
                <input type="text" id="messageInput" placeholder="Type a message...">
                <button id="sendBtn">Send</button>
            </div>
        </div>
    </div>
</div>

<div class="modal" id="profileModal">
    <div class="modal-content">
        <h3>Edit Profile</h3>
        <div class="avatar-preview" id="avatarPreview">👤</div>
        <input type="text" id="displayNameInput" placeholder="Display name">
        <textarea id="bioInput" placeholder="Bio"></textarea>
        <input type="text" id="avatarInput" placeholder="Avatar emoji (e.g., 😀)">
        <button id="saveProfileBtn">Save Changes</button>
        <button class="close-btn" id="closeModalBtn">Cancel</button>
    </div>
</div>

<input type="file" id="fileInput" style="display:none">

<script>
    // DOM elements
    const loginScreen = document.getElementById('loginScreen');
    const chatContainer = document.getElementById('chatContainer');
    const usernameInput = document.getElementById('usernameInput');
    const joinButton = document.getElementById('joinButton');
    const statusBar = document.getElementById('statusBar');
    const onlineCountSpan = document.getElementById('onlineCount');
    const chatTitle = document.getElementById('chatTitle');
    const chatsList = document.getElementById('chatsList');
    const messagesList = document.getElementById('messagesList');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const fileBtn = document.getElementById('fileBtn');
    const fileInput = document.getElementById('fileInput');
    const profileBtn = document.getElementById('profileBtn');
    const profileModal = document.getElementById('profileModal');
    const displayNameInput = document.getElementById('displayNameInput');
    const bioInput = document.getElementById('bioInput');
    const avatarInput = document.getElementById('avatarInput');
    const avatarPreview = document.getElementById('avatarPreview');
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');
    
    let ws = null;
    let currentUser = '';
    let currentChat = null;
    let reconnectAttempts = 0;
    let pingInterval = null;
    let userProfile = {};
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = protocol + '//' + window.location.host;
    
    const saved = localStorage.getItem('username');
    if (saved) usernameInput.value = saved;
    
    // LOGIN FUNCTION
    function login() {
        const name = usernameInput.value.trim();
        if (!name) { alert('Enter your name'); return; }
        if (name.length < 2) { alert('Name must be at least 2 characters'); return; }
        currentUser = name;
        localStorage.setItem('username', name);
        loginScreen.style.display = 'none';
        chatContainer.style.display = 'flex';
        connect();
    }
    
    // CONNECT WEBSOCKET
    function connect() {
        const wsUrl = WS_URL + '?username=' + encodeURIComponent(currentUser);
        if (ws) try { ws.close(); } catch(e) {}
        
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            statusBar.innerHTML = '🟢 Connected';
            statusBar.style.background = '#1e4a3b';
            reconnectAttempts = 0;
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(function() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 25000);
            loadChats();
            loadProfile();
        };
        
        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'private_message') {
                    if (currentChat === data.from) {
                        addMessage(data.from, data.text, false, data.file, data.fileName);
                    }
                    loadChats();
                } else if (data.type === 'user_list') {
                    const others = data.users.filter(function(u) { return u !== currentUser; });
                    onlineCountSpan.innerHTML = others.length + ' online';
                } else if (data.type === 'history') {
                    displayMessages(data.messages);
                } else if (data.type === 'chats_list') {
                    displayChats(data.chats);
                } else if (data.type === 'profile') {
                    userProfile = data.profile;
                    updateProfileUI();
                } else if (data.type === 'profile_updated') {
                    addSystemMessage('Profile updated!');
                    loadProfile();
                } else if (data.type === 'system') {
                    addSystemMessage(data.text);
                }
            } catch(e) {}
        };
        
        ws.onerror = function() {
            statusBar.innerHTML = '🔴 Connection error';
            statusBar.style.background = '#6b2e2e';
        };
        
        ws.onclose = function() {
            statusBar.innerHTML = '🔴 Disconnected. Reconnecting...';
            statusBar.style.background = '#6b2e2e';
            if (pingInterval) clearInterval(pingInterval);
            if (reconnectAttempts < 15) {
                setTimeout(function() {
                    reconnectAttempts++;
                    connect();
                }, 3000);
            }
        };
    }
    
    function loadProfile() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_profile' }));
        }
    }
    
    function updateProfileUI() {
        if (userProfile) {
            avatarPreview.innerHTML = userProfile.avatar || '👤';
            displayNameInput.value = userProfile.display_name || '';
            bioInput.value = userProfile.bio || '';
            avatarInput.value = userProfile.avatar || '👤';
        }
    }
    
    function saveProfile() {
        const data = {
            display_name: displayNameInput.value.trim(),
            bio: bioInput.value.trim(),
            avatar: avatarInput.value.trim() || '👤'
        };
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'update_profile', data: data }));
            closeModal();
        }
    }
    
    function loadChats() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_chats' }));
        }
    }
    
    function displayChats(chats) {
        if (!chatsList) return;
        let html = '';
        for (let i = 0; i < chats.length; i++) {
            const chat = chats[i];
            const isActive = (currentChat === chat.chat_user);
            html += '<div class="chat-item' + (isActive ? ' active' : '') + '" onclick="selectChat(\'' + escapeHtml(chat.chat_user) + '\')">';
            html += '<div class="chat-name">' + escapeHtml(chat.chat_user) + '</div>';
            html += '</div>';
        }
        if (html === '') {
            html = '<div style="padding: 16px; color: #8e9eae; text-align: center;">No chats yet</div>';
        }
        chatsList.innerHTML = html;
    }
    
    function selectChat(username) {
        if (username === currentUser) return;
        currentChat = username;
        chatTitle.innerHTML = '💬 Chat with ' + escapeHtml(username);
        messagesList.innerHTML = '';
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_history', with: username }));
        }
        loadChats();
    }
    
    function displayMessages(messages) {
        if (!messagesList) return;
        messagesList.innerHTML = '';
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const isOwn = (msg.from_user === currentUser);
            const displayText = msg.message ? (msg.message.includes(':') ? '🔒 Encrypted' : msg.message) : msg.message;
            addMessageToContainer(msg.from_user, displayText, false, null, null, isOwn, msg.created_at);
        }
        messagesList.scrollTop = messagesList.scrollHeight;
    }
    
    function addMessage(user, text, isOwn, fileData, fileName) {
        addMessageToContainer(user, text, false, fileData, fileName, isOwn, new Date());
        messagesList.scrollTop = messagesList.scrollHeight;
    }
    
    function addMessageToContainer(user, text, isEncrypted, fileData, fileName, isOwn, timestamp) {
        const div = document.createElement('div');
        div.className = 'message' + (isOwn ? ' own' : '');
        const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        if (fileData && fileName) {
            const fileUrl = 'data:application/octet-stream;base64,' + fileData;
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-file" onclick="downloadFile(\'' + fileUrl + '\', \'' + fileName + '\')">📎 ' + escapeHtml(fileName) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        } else {
            const displayText = isEncrypted ? '🔒 Encrypted' : (text || '');
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-bubble">' + escapeHtml(displayText) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        }
        messagesList.appendChild(div);
    }
    
    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'message';
        div.style.opacity = '0.7';
        div.style.alignItems = 'center';
        div.innerHTML = '<div class="message-bubble" style="background:#2b3b4c;font-size:12px;">' + escapeHtml(text) + '</div>';
        messagesList.appendChild(div);
        messagesList.scrollTop = messagesList.scrollHeight;
    }
    
    function downloadFile(url, name) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
    }
    
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        if (!currentChat) {
            addSystemMessage('Select a chat first');
            return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'message', text: text, to: currentChat, private: true }));
            messageInput.value = '';
            addMessage(currentUser, text, true, null, null);
        } else {
            addSystemMessage('No connection');
        }
    }
    
    function sendFile(file) {
        if (!file) return;
        if (!currentChat) {
            addSystemMessage('Select a chat first');
            return;
        }
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64 = e.target.result.split(',')[1];
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'file', fileName: file.name, fileType: file.type, fileData: base64, to: currentChat, private: true }));
                addMessage(currentUser, null, true, base64, file.name);
            }
        };
        reader.readAsDataURL(file);
    }
    
    function openModal() {
        loadProfile();
        profileModal.classList.add('active');
    }
    
    function closeModal() {
        profileModal.classList.remove('active');
    }
    
    function handleKeyPress(e) {
        if (e.key === 'Enter') sendMessage();
    }
    
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }
    
    // ========== EVENT LISTENERS ==========
    joinButton.onclick = login;
    sendBtn.onclick = sendMessage;
    fileBtn.onclick = function() { fileInput.click(); };
    fileInput.onchange = function(e) { if (e.target.files[0]) sendFile(e.target.files[0]); };
    messageInput.onkeypress = handleKeyPress;
    usernameInput.onkeypress = function(e) { if (e.key === 'Enter') login(); };
    profileBtn.onclick = openModal;
    saveProfileBtn.onclick = saveProfile;
    closeModalBtn.onclick = closeModal;
    profileModal.onclick = function(e) { if (e.target === profileModal) closeModal(); };
</script>
</body>
</html>`;

// ========== HTTP ==========
app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(activeUsers), count: Object.keys(activeUsers).length });
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws, req) => {
    let currentUser = null;
    let pingInterval = null;
    
    const url = new URL(req.url, 'http://' + req.headers.host);
    const username = url.searchParams.get('username');
    
    if (!username || !username.trim()) {
        ws.close();
        return;
    }
    
    currentUser = username.trim();
    
    createUser(currentUser).then(() => {
        console.log('User ready: ' + currentUser);
    });
    
    if (activeUsers[currentUser]) {
        try { activeUsers[currentUser].close(); } catch(e) {}
        delete activeUsers[currentUser];
    }
    
    activeUsers[currentUser] = ws;
    console.log('User connected: ' + currentUser);
    
    ws.send(JSON.stringify({ type: 'system', text: 'Welcome, ' + currentUser + '!' }));
    broadcastUserList();
    
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'message' && message.text && message.to) {
                const encryptedMsg = encrypt(message.text);
                await saveMessage(currentUser, message.to, encryptedMsg);
                if (activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        text: message.text,
                        timestamp: Date.now()
                    });
                }
                console.log(currentUser + ' -> ' + message.to + ': ' + message.text);
                
            } else if (message.type === 'file' && message.fileData && message.to) {
                await saveMessage(currentUser, message.to, '', message.fileData, message.fileName);
                if (activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        file: message.fileData,
                        fileName: message.fileName,
                        timestamp: Date.now()
                    });
                }
                console.log(currentUser + ' -> ' + message.to + ': [FILE] ' + message.fileName);
                
            } else if (message.type === 'get_history' && message.with) {
                const history = await getMessages(currentUser, message.with);
                ws.send(JSON.stringify({ type: 'history', messages: history }));
                
            } else if (message.type === 'get_chats') {
                const chats = await getUserChats(currentUser);
                ws.send(JSON.stringify({ type: 'chats_list', chats: chats }));
                
            } else if (message.type === 'get_profile') {
                const profile = await getUserProfile(currentUser);
                ws.send(JSON.stringify({ type: 'profile', profile: profile }));
                
            } else if (message.type === 'update_profile') {
                await updateUserProfile(currentUser, message.data);
                ws.send(JSON.stringify({ type: 'profile_updated' }));
                broadcastUserList();
                
            } else if (message.type === 'ping') {
                // keep alive
            }
        } catch(e) {
            console.log('Error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log('User disconnected: ' + currentUser);
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && activeUsers[currentUser]) {
            delete activeUsers[currentUser];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
    console.log('Encryption enabled');
    console.log('Database: messenger.db');
});
