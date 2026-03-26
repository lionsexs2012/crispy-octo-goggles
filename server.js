const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище пользователей
let users = {}; // username -> { ws, lastPing }

// Раздача статики
app.use(express.static(path.join(__dirname, 'public')));

console.log('🚀 Messenger server starting...');

wss.on('connection', (ws, req) => {
    let currentUser = null;
    let pingInterval = null;
    
    // Получаем username из URL
    const url = new URL(req.url, `http://${req.headers.host}`);
    const username = url.searchParams.get('username');
    
    if (!username || !username.trim()) {
        ws.close();
        return;
    }
    
    currentUser = username.trim();
    
    // Если пользователь уже есть, отключаем старого
    if (users[currentUser]) {
        try {
            users[currentUser].ws.close();
        } catch(e) {}
        delete users[currentUser];
    }
    
    users[currentUser] = { ws, lastPing: Date.now() };
    console.log(`✅ ${currentUser} connected`);
    
    // Приветствие
    ws.send(JSON.stringify({
        type: 'system',
        text: `Добро пожаловать, ${currentUser}!`
    }));
    
    // Рассылаем обновленный список
    broadcastUserList();
    
    // Пинг для поддержания соединения
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 25000);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            switch(message.type) {
                case 'message':
                    if (message.text && message.text.trim()) {
                        console.log(`📨 ${currentUser}: ${message.text}`);
                        broadcast(JSON.stringify({
                            type: 'message',
                            user: currentUser,
                            text: message.text.trim(),
                            timestamp: Date.now()
                        }));
                    }
                    break;
                    
                case 'ping':
                    if (users[currentUser]) {
                        users[currentUser].lastPing = Date.now();
                    }
                    break;
                    
                default:
                    console.log('Unknown type:', message.type);
            }
        } catch(e) {
            console.log('Parse error:', e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`❌ ${currentUser} disconnected`);
        if (pingInterval) clearInterval(pingInterval);
        if (currentUser && users[currentUser]) {
            delete users[currentUser];
            broadcastUserList();
        }
    });
    
    ws.on('error', (err) => {
        console.log(`⚠️ Error ${currentUser}: ${err.message}`);
    });
});

function broadcast(data) {
    for (let user in users) {
        if (users[user].ws.readyState === WebSocket.OPEN) {
            try {
                users[user].ws.send(data);
            } catch(e) {}
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

// API статус
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        users: Object.keys(users),
        count: Object.keys(users).length,
        uptime: process.uptime()
    });
});

// Корневой маршрут
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🎉 Server running on port ${PORT}`);
    console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
    console.log(`📱 Client: http://localhost:${PORT}`);
});
