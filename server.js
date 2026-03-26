const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============== БАЗА ДАННЫХ ==============
const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
    // Пользователи
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        public_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user TEXT,
        to_user TEXT,
        encrypted_message TEXT,
        file_data TEXT,
        file_name TEXT,
        file_type TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Сессии
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        username TEXT PRIMARY KEY,
        ws_id TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ============== ШИФРОВАНИЕ ==============
const ENCRYPTION_KEY = crypto.randomBytes(32); // В продакшене хранить в переменной окружения!
const IV_LENGTH = 16;

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ============== ХРАНЕНИЕ АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ ==============
let activeUsers = {}; // username -> { ws, privateKey? }

// ============== ФУНКЦИИ БАЗЫ ДАННЫХ ==============
function saveMessage(from, to, encryptedMsg, fileData = null, fileName = null, fileType = null) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO messages (from_user, to_user, encrypted_message, file_data, file_name, file_type) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [from, to, encryptedMsg, fileData, fileName, fileType],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getMessages(user1, user2, limit = 50) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM messages 
             WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
             ORDER BY created_at DESC LIMIT ?`,
            [user1, user2, user2, user1, limit],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows.reverse());
            }
        );
    });
}

function markAsRead(messageId) {
    db.run(`UPDATE messages SET is_read = 1 WHERE id = ?`, [messageId]);
}

// ============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==============
function broadcast(data) {
    for (let user in activeUsers) {
        if (activeUsers[user].ws.readyState === WebSocket.OPEN) {
            try { activeUsers[user].ws.send(JSON.stringify(data)); } catch(e) {}
        }
    }
}

function sendToUser(username, data) {
    if (activeUsers[username] && activeUsers[username].ws.readyState === WebSocket.OPEN) {
        activeUsers[username].ws.send(JSON.stringify(data));
    }
}

function broadcastUserList() {
    const userList = Object.keys(activeUsers);
    broadcast({ type: 'user_list', users: userList });
}

// ============== HTML КЛИЕНТ ==============
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
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
        .private-badge {
            background: #6b2e2e;
            padding: 6px 12px;
            border-radius: 20px;
            color: #fff;
            font-size: 11px;
            cursor: pointer;
        }
        .connection-status {
            font-size: 11px;
            padding: 6px;
            text-align: center;
            background: #2b3b4c;
            color: #fff;
        }
        .chat-area {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        .users-sidebar {
            width: 260px;
            background: #17212b;
            border-right: 1px solid #2b3b4c;
            overflow-y: auto;
            display: none;
        }
        .users-sidebar.show {
            display: block;
        }
        .user-item {
            padding: 12px 16px;
            color: #fff;
            cursor: pointer;
            border-bottom: 1px solid #2b3b4c;
        }
        .user-item:hover { background: #242f3e; }
        .user-item.active { background: #2b5278; }
        .user-item.online { border-left: 3px solid #2b5278; }
        .messages-area {
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
        .message-file {
            background: #242f3e;
            padding: 8px 12px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
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
            padding: 12px;
            border-radius: 24px;
            cursor: pointer;
        }
        .private-indicator {
            background: #6b2e2e;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 10px;
            margin-left: 8px;
        }
        @media (max-width: 768px) {
            .users-sidebar { width: 200px; }
        }
    </style>
</head>
<body>
<div class="login-screen" id="loginScreen">
    <div class="login-card">
        <h2>🔒 Secure Messenger</h2>
        <p>Enter your name to start</p>
        <input type="text" id="usernameInput" placeholder="Your name" maxlength="24">
        <button onclick="login()">Join</button>
    </div>
</div>
<div class="chat-container" id="chatContainer">
    <div class="chat-header">
        <h2 id="chatTitle">💬 Secure Messenger</h2>
        <div class="header-right">
            <div class="online-badge" id="onlineCount">0 online</div>
            <div class="private-badge" id="privateBadge" onclick="togglePrivateMode()">🔓 Public</div>
            <button style="background:none; border:none; color:#8e9eae; font-size:20px;" onclick="toggleSidebar()">☰</button>
        </div>
    </div>
    <div class="connection-status" id="connStatus">Connecting...</div>
    <div class="chat-area">
        <div class="users-sidebar" id="usersSidebar">
            <div class="users-list" id="usersList"></div>
        </div>
        <div class="messages-area">
            <div class="messages-list" id="messagesList"></div>
            <div class="input-area">
                <div class="file-btn" onclick="document.getElementById('fileInput').click()">📎</div>
                <input type="text" id="messageInput" placeholder="Message..." onkeypress="handleKeyPress(event)">
                <button onclick="sendMessage()">Send</button>
            </div>
        </div>
    </div>
</div>
<input type="file" id="fileInput" style="display:none" onchange="sendFile(this.files[0])">

<script>
    let ws = null;
    let currentUser = "";
    let currentChat = "public";
    let isPrivateMode = false;
    let reconnectAttempts = 0;
    let pingInterval = null;
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const WS_URL = protocol + "//" + window.location.host;
    
    const savedName = localStorage.getItem("messengerUsername");
    if (savedName) {
        document.getElementById("usernameInput").value = savedName;
    }
    
    function login() {
        let name = document.getElementById("usernameInput").value.trim();
        if (!name) { alert("Enter your name"); return; }
        if (name.length < 2) { alert("Name must be at least 2 characters"); return; }
        currentUser = name;
        localStorage.setItem("messengerUsername", name);
        document.getElementById("loginScreen").style.display = "none";
        document.getElementById("chatContainer").style.display = "flex";
        connectWebSocket();
    }
    
    function connectWebSocket() {
        let wsUrl = WS_URL + "?username=" + encodeURIComponent(currentUser);
        if (ws) { try { ws.close(); } catch(e) {} }
        ws = new WebSocket(wsUrl);
        ws.onopen = function() {
            document.getElementById("connStatus").innerHTML = "Connected";
            document.getElementById("connStatus").style.background = "#1e4a3b";
            reconnectAttempts = 0;
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(function() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                }
            }, 25000);
            loadHistory();
        };
        ws.onmessage = function(event) {
            try {
                let data = JSON.parse(event.data);
                switch(data.type) {
                    case 'message':
                        if ((isPrivateMode && data.from === currentChat) || (!isPrivateMode && data.to === "public")) {
                            addMessage(data.from, data.text, data.from === currentUser, data.file, data.fileName);
                        }
                        break;
                    case 'private_message':
                        if (isPrivateMode && data.from === currentChat) {
                            addMessage(data.from, data.text, data.from === currentUser, data.file, data.fileName);
                        } else if (!isPrivateMode && data.from === currentUser) {
                            // notif
                        }
                        break;
                    case 'user_list':
                        updateUserList(data.users);
                        break;
                    case 'history':
                        loadHistoryMessages(data.messages);
                        break;
                    case 'system':
                        addSystemMessage(data.text);
                        break;
                }
            } catch(e) {}
        };
        ws.onerror = function() {
            document.getElementById("connStatus").innerHTML = "Error";
            document.getElementById("connStatus").style.background = "#6b2e2e";
        };
        ws.onclose = function() {
            document.getElementById("connStatus").innerHTML = "Disconnected. Reconnecting...";
            document.getElementById("connStatus").style.background = "#6b2e2e";
            if (pingInterval) clearInterval(pingInterval);
            if (reconnectAttempts < 15) {
                setTimeout(function() { reconnectAttempts++; connectWebSocket(); }, 3000);
            }
        };
    }
    
    function loadHistory() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "get_history", with: currentChat, private: isPrivateMode }));
        }
    }
    
    function loadHistoryMessages(messages) {
        let container = document.getElementById("messagesList");
        container.innerHTML = "";
        messages.forEach(msg => {
            addMessage(msg.from_user, msg.encrypted_message ? decryptMessage(msg.encrypted_message) : msg.text, msg.from_user === currentUser, msg.file_data, msg.file_name);
        });
    }
    
    function decryptMessage(encrypted) {
        // На клиенте шифрование/дешифрование через сервер
        return encrypted;
    }
    
    function sendMessage() {
        let text = document.getElementById("messageInput").value.trim();
        if (!text) return;
        let messageData = { type: "message", text: text, private: isPrivateMode, to: currentChat };
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(messageData));
            document.getElementById("messageInput").value = "";
            if (isPrivateMode) {
                addMessage(currentUser, text, true);
            }
        } else {
            addSystemMessage("No connection");
        }
    }
    
    function sendFile(file) {
        if (!file) return;
        let reader = new FileReader();
        reader.onload = function(e) {
            let base64 = e.target.result.split(',')[1];
            let messageData = { type: "file", fileName: file.name, fileType: file.type, fileData: base64, private: isPrivateMode, to: currentChat };
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(messageData));
            }
        };
        reader.readAsDataURL(file);
    }
    
    function addMessage(user, text, isOwn, fileData, fileName) {
        let container = document.getElementById("messagesList");
        let div = document.createElement("div");
        div.className = "message" + (isOwn ? " own" : "");
        let time = new Date().toLocaleTimeString([], {hour: "2-digit", minute:"2-digit"});
        
        if (fileData && fileName) {
            let fileUrl = "data:application/octet-stream;base64," + fileData;
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-file" onclick="downloadFile(\'' + fileUrl + '\', \'' + fileName + '\')">📎 ' + escapeHtml(fileName) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        } else {
            div.innerHTML = '<div class="message-name">' + escapeHtml(user) + '</div>' +
                '<div class="message-bubble">' + escapeHtml(text) + '</div>' +
                '<div class="message-time">' + time + '</div>';
        }
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
    
    function downloadFile(url, name) {
        let a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
    }
    
    function addSystemMessage(text) {
        let container = document.getElementById("messagesList");
        let div = document.createElement("div");
        div.className = "message";
        div.style.opacity = "0.7";
        div.style.textAlign = "center";
        div.innerHTML = '<div class="message-bubble" style="background:#2b3b4c;font-size:12px;">' + escapeHtml(text) + '</div>';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
    
    function updateUserList(users) {
        document.getElementById("onlineCount").innerHTML = users.length + " online";
        let container = document.getElementById("usersList");
        let html = '<div class="user-item" onclick="selectChat(\'public\')">🌍 Public Chat</div>';
        users.forEach(u => {
            if (u !== currentUser) {
                html += '<div class="user-item ' + (currentChat === u ? 'active' : '') + '" onclick="selectChat(\'' + escapeHtml(u) + '\')">💬 ' + escapeHtml(u) + '</div>';
            }
        });
        container.innerHTML = html;
    }
    
    function selectChat(user) {
        currentChat = user;
        isPrivateMode = true;
        document.getElementById("chatTitle").innerHTML = "💬 Chat with " + escapeHtml(user);
        document.getElementById("privateBadge").innerHTML = "🔒 Private";
        document.getElementById("privateBadge").style.background = "#1e4a3b";
        document.getElementById("messagesList").innerHTML = "";
        loadHistory();
    }
    
    function togglePrivateMode() {
        if (isPrivateMode) {
            currentChat = "public";
            isPrivateMode = false;
            document.getElementById("chatTitle").innerHTML = "💬 Secure Messenger";
            document.getElementById("privateBadge").innerHTML = "🔓 Public";
            document.getElementById("privateBadge").style.background = "#6b2e2e";
            document.getElementById("messagesList").innerHTML = "";
            loadHistory();
        } else {
            // switch to private mode - select first user or show sidebar
            document.getElementById("usersSidebar").classList.toggle("show");
        }
    }
    
    function toggleSidebar() {
        document.getElementById("usersSidebar").classList.toggle("show");
    }
    
    function handleKeyPress(e) {
        if (e.key === "Enter") sendMessage();
    }
    
    function escapeHtml(str) {
        if (!str) return "";
        return str.replace(/[&<>]/g, function(m) {
            if (m === "&") return "&amp;";
            if (m === "<") return "&lt;";
            if (m === ">") return "&gt;";
            return m;
        });
    }
</script>
</body>
</html>`;

// ============== EXPRESS РОУТЫ ==============
app.get('/', (req, res) => {
    res.send(HTML_PAGE);
});

app.get('/api/status', (req, res) => {
    res.json({ 
        status: 'ok', 
        users: Object.keys(activeUsers), 
        count: Object.keys(activeUsers).length 
    });
});

// ============== WEBSOCKET ОБРАБОТЧИК ==============
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
    
    // Сохраняем пользователя в БД
    db.run(`INSERT OR IGNORE INTO users (username) VALUES (?)`, [currentUser]);
    
    // Отключаем старого пользователя если был
    if (activeUsers[currentUser]) {
        try { activeUsers[currentUser].ws.close(); } catch(e) {}
        delete activeUsers[currentUser];
    }
    
    activeUsers[currentUser] = { ws: ws, lastPing: Date.now() };
    console.log(`✅ ${currentUser} connected`);
    
    ws.send(JSON.stringify({ type: 'system', text: `Welcome, ${currentUser}!` }));
    broadcastUserList();
    
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'message') {
                let encryptedMsg = encrypt(message.text);
                let target = message.private ? message.to : 'public';
                
                await saveMessage(currentUser, target, encryptedMsg);
                
                if (message.private && activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        text: message.text,
                        timestamp: Date.now()
                    });
                } else if (!message.private) {
                    broadcast({
                        type: 'message',
                        from: currentUser,
                        text: message.text,
                        to: 'public',
                        timestamp: Date.now()
                    });
                }
                
                console.log(`📨 ${currentUser} -> ${target}: ${message.text}`);
                
            } else if (message.type === 'file') {
                let target = message.private ? message.to : 'public';
                await saveMessage(currentUser, target, '', message.fileData, message.fileName, message.fileType);
                
                if (message.private && activeUsers[message.to]) {
                    sendToUser(message.to, {
                        type: 'private_message',
                        from: currentUser,
                        file: message.fileData,
                        fileName: message.fileName,
                        timestamp: Date.now()
                    });
                } else if (!message.private) {
                    broadcast({
                        type: 'message',
                        from: currentUser,
                        file: message.fileData,
                        fileName: message.fileName,
                        to: 'public',
                        timestamp: Date.now()
                    });
                }
                
            } else if (message.type === 'get_history') {
                let target = message.private ? message.with : 'public';
                let history = await getMessages(currentUser, target);
                ws.send(JSON.stringify({ type: 'history', messages: history }));
                
            } else if (message.type === 'ping') {
                if (activeUsers[currentUser]) {
                    activeUsers[currentUser].lastPing = Date.now();
                }
            }
        } catch(e) {
            console.log('Parse error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`❌ ${currentUser} disconnected`);
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && activeUsers[currentUser]) {
            delete activeUsers[currentUser];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🎉 Server running on port ${PORT}`);
    console.log(`🔒 Encryption enabled`);
    console.log(`💾 Database: messenger.db`);
});
