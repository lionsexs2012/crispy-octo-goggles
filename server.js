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
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, display_name TEXT, bio TEXT, avatar TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, message TEXT, file_data TEXT, file_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
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
        db.run("INSERT INTO messages (from_user, to_user, message, file_data, file_name) VALUES (?, ?, ?, ?, ?)",
            [from, to, message, fileData, fileName],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
}

function getMessages(user1, user2) {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY created_at ASC",
            [user1, user2, user2, user1],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserChats(username) {
    return new Promise((resolve, reject) => {
        db.all("SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END as chat_user FROM messages WHERE from_user = ? OR to_user = ?",
            [username, username, username],
            (err, rows) => { if (err) reject(err); else resolve(rows); }
        );
    });
}

function getUserProfile(username) {
    return new Promise((resolve, reject) => {
        db.get("SELECT username, display_name, bio, avatar FROM users WHERE username = ?", [username], (err, row) => {
            if (err) reject(err);
            else resolve(row || { username, display_name: username, bio: '', avatar: '👤' });
        });
    });
}

function updateUserProfile(username, data) {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET display_name = ?, bio = ?, avatar = ? WHERE username = ?",
            [data.display_name  username, data.bio  '', data.avatar || '👤', username],
            function(err) { if (err) reject(err); else resolve(this.changes); }
        );
    });
}

function createUser(username) {
    return new Promise((resolve) => {
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (!row) {
                db.run("INSERT INTO users (username, display_name, bio, avatar) VALUES (?, ?, ?, ?)",
                    [username, username, '', '👤']);
            }
            resolve();
        });
    });
}

const HTML = <!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Messenger</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0e1621;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login {
            background: #17212b;
            padding: 32px;
            border-radius: 28px;
            width: 300px;
            text-align: center;
        }
        .login h2 { color: #fff; margin-bottom: 20px; }
        .login input {
            width: 100%;
            padding: 14px;
            background: #242f3e;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-size: 16px;
            margin-bottom: 16px;
        }
        .login button {
            width: 100%;
            padding: 14px;
            background: #2b5278;
            border: none;
            border-radius: 16px;
            color: #fff;
            font-weight: bold;
            cursor: pointer;
        }
        .chat { display: none; flex-direction: column; height: 100vh; width: 100%; }
        .header { background: #17212b; padding: 12px; color: #fff; text-align: center; }
        .messages { flex: 1; overflow-y: auto; padding: 16px; }
        .msg { margin-bottom: 12px; }
        .msg.own { text-align: right; }
        .msg-bubble {
            display: inline-block;
            padding: 8px 12px;
            border-radius: 18px;
            background: #17212b;
            color: #fff;
            max-width: 70%;
        }
        .msg.own .msg-bubble { background: #2b5278; }
        .input-area {
            background: #17212b;
            padding: 12px;
            display: flex;
            gap: 8px;
        }
        .input-area input {
            flex: 1;
            padding: 12px;
            background: #242f3e;
            border: none;
            border-radius: 24px;
            color: #fff;
        }
        .input-area button {
            padding: 12px 20px;
            background: #2b5278;
            border: none;
            border-radius: 24px;
            color: #fff;
            cursor: pointer;
        }
        .users-list {
            background: #17212b;
            padding: 12px;
            border-bottom: 1px solid #2b3b4c;
            display: flex;
            gap: 8px;
            overflow-x: auto;
        }
        .user-chip {
            background: #242f3e;
            padding: 6px 12px;
            border-radius: 20px;
            color: #fff;
            cursor: pointer;
        }
        .user-chip.active { background: #2b5278; }
    </style>
</head>
<body>

<div id="loginScreen" class="login">
    <h2>🔒 Messenger</h2>
    <input type="text" id="username" placeholder="Your name">
    <button id="joinBtn">Join</button>
</div>

<div id="chatScreen" class="chat">
    <div class="header">
        <span id="chatTitle">💬 Messenger</span>
    </div>
    <div class="users-list" id="usersList"></div>
    <div class="messages" id="messages"></div>
    <div class="input-area">
        <input type="text" id="messageInput" placeholder="Type a message...">
        <button id="sendBtn">Send</button>
    </div>
</div>

<script>
    const loginScreen = document.getElementById('loginScreen');
    const chatScreen = document.getElementById('chatScreen');
    const usernameInput = document.getElementById('username');
    const joinBtn = document.getElementById('joinBtn');
    const messagesDiv = document.getElementById('messages');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const usersList = document.getElementById('usersList');
    const chatTitle = document.getElementById('chatTitle');
    
    let ws = null;
    let currentUser = '';
    let currentChat = '';
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = protocol + '//' + location.host;
    
    function login() {
        const name = usernameInput.value.trim();
        if (!name) { alert('Enter your name'); return; }
        if (name.length < 2) { alert('Min 2 characters'); return; }
        currentUser = name;
        localStorage.setItem('username', name);
        loginScreen.style.display = 'none';
        chatScreen.style.display = 'flex';
        connect();
    }
    
    function connect() {
        ws = new WebSocket(WS_URL + '?username=' + encodeURIComponent(currentUser));
        
        ws.onopen = () => {
            addSystemMessage('Connected');
        };
        
        ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === 'private_message') {
                if (currentChat === data.from) {
                    addMessage(data.from, data.text, false);
                }
                loadUsers();
            } else if (data.type === 'user_list') {
                updateUsersList(data.users);
            } else if (data.type === 'history') {
                data.messages.forEach(msg => {
                    addMessage(msg.from_user, msg.message, msg.from_user === currentUser);
                });
            } else if (data.type === 'system') {
                addSystemMessage(data.text);
            }
        };
        
        ws.onclose = () => {
            addSystemMessage('Disconnected, reconnecting...');
            setTimeout(connect, 3000);
        };
    }
    
    function updateUsersList(users) {
        let html = '<div class="user-chip" onclick="selectChat(\'\')">🌍 Public</div>';
        users.forEach(u => {
            if (u !== currentUser) {
                const active = currentChat === u ? 'active' : '';
                html += '<div class="user-chip ' + active + '" onclick="selectChat(\'' + u + '\')">' + u + '</div>';
            }
        });
        usersList.innerHTML = html;
    }
    
    function selectChat(user) {
        currentChat = user;
        chatTitle.innerHTML = user ? '💬 Chat with ' + user : '💬 Public Chat';
        messagesDiv.innerHTML = '';
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_history', with: user }));
        }
        loadUsers();
    }
    
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text) return;
        if (!currentChat && currentChat !== '') { addSystemMessage('Select a chat first'); return; }
        
        ws.send(JSON.stringify({
            type: 'message',
            text: text,
            to: currentChat || 'public',
            private: true
        }));
        messageInput.value = '';
        addMessage(currentUser, text, true);
    }
    
    function addMessage(user, text, isOwn) {
        const div = document.createElement('div');
        div.className = 'msg' + (isOwn ? ' own' : '');
        div.innerHTML = '<div class="msg-bubble"><b>' + escapeHtml(user) + '</b><br>' + escapeHtml(text) + '</div>';
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.style.textAlign = 'center';
        div.style.color = '#8e9eae';
        div.style.fontSize = '12px';
        div.style.padding = '8px';
        div.innerText = text;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    function loadUsers() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'get_chats' }));
        }
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
    
    joinBtn.onclick = login;
    sendBtn.onclick = sendMessage;
    messageInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
    usernameInput.onkeypress = (e) => { if (e.key === 'Enter') login(); };
    
    const saved = localStorage.getItem('username');
    if (saved) usernameInput.value = saved;
    
    window.selectChat = selectChat;
</script>
</body>
</html>;

app.get('/', (req, res) => {
    res.send(HTML);
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(activeUsers), count: Object.keys(activeUsers).length });
});

wss.on('connection', (ws, req) => {
    let currentUser = null;
    const url = new URL(req.url, 'http://' + req.headers.host);
    const username = url.searchParams.get('username');
    
    if (!username || !username.trim()) {
        ws.close();
        return;
    }
    
    currentUser = username.trim();
    createUser(currentUser);
    
    if (activeUsers[currentUser]) {
        try { activeUsers[currentUser].close(); } catch(e) {}
        delete activeUsers[currentUser];
    }
    activeUsers[currentUser] = ws;
    
    ws.send(JSON.stringify({ type: 'system', text: 'Welcome, ' + currentUser }));
    broadcastUserList();
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'message' && msg.text && msg.to) {
                const encrypted = encrypt(msg.text);
                await saveMessage(currentUser, msg.to, encrypted);
                if (activeUsers[msg.to]) {
                    sendToUser(msg.to, {
                        type: 'private_message',
                        from: currentUser,
                        text: msg.text
                    });
                }
            } else if (msg.type === 'get_history' && msg.with !== undefined) {
                const history = await getMessages(currentUser, msg.with);
                ws.send(JSON.stringify({ type: 'history', messages: history }));
            } else if (msg.type === 'get_chats') {
                const chats = await getUserChats(currentUser);
                ws.send(JSON.stringify({ type: 'chats_list', chats: chats }));
            }
        } catch(e) {}
    });
    
    ws.on('close', () => {
        delete activeUsers[currentUser];
        broadcastUserList();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});
